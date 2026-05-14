import type {
  EmbeddingArtifact,
  EmbeddingChunkVector,
  SttChunkTranscript,
  SttTranscriptArtifact,
} from "../domain/types.js";

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_CHUNK_SECONDS = 25;
const EMBEDDING_CHUNK_MAX_CHARS = 2500;

export class GigaChatFoundation {
  private tokenCache:
    | {
        token: string;
        expiresAt: number;
      }
    | undefined;

  constructor(
    private readonly config: {
      baseURL?: string;
      authURL?: string;
      scope?: string;
      model?: string;
      embeddingsModel?: string;
      sttModel?: string;
      verifySslCerts: boolean;
      clientId?: string;
      clientSecret?: string;
      accessToken?: string;
      rawEnv?: Record<string, string>;
    },
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.baseURL && (this.config.accessToken || (this.config.authURL && this.config.clientId && this.config.clientSecret)));
  }

  async transcribeAudio(args: {
    audio: Buffer;
    sourceAudioRef: string;
    language?: string;
    chunkSeconds?: number;
  }): Promise<SttTranscriptArtifact> {
    if (!this.isConfigured()) {
      throw new Error("GigaChat STT is not configured.");
    }

    const chunkSize = inferPcmChunkSize(args.audio.length, args.chunkSeconds ?? DEFAULT_CHUNK_SECONDS);
    const audioChunks = splitBuffer(args.audio, chunkSize);
    const transcripts: SttChunkTranscript[] = [];

    for (let i = 0; i < audioChunks.length; i += 1) {
      const rawText = await this.requestWithRetry<string>(async () => {
        const token = await this.getAccessToken();
        const response = await fetch(`${this.config.baseURL}/stt/transcriptions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.sttModel || this.config.model,
            audio_base64: audioChunks[i].toString("base64"),
            language: args.language ?? "ru",
          }),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`GigaChat STT failed (${response.status}): ${text}`);
        }
        const parsed = (await response.json()) as { text?: string; transcript?: string };
        return (parsed.text ?? parsed.transcript ?? "").trim();
      });

      const cleaned = normalizeSttChunk(rawText);
      transcripts.push({
        chunkIndex: i,
        startedAtMs: i * 1000 * (args.chunkSeconds ?? DEFAULT_CHUNK_SECONDS),
        endedAtMs: (i + 1) * 1000 * (args.chunkSeconds ?? DEFAULT_CHUNK_SECONDS),
        rawText,
        text: cleaned,
      });
    }

    const rawTranscript = transcripts.map((chunk) => chunk.rawText).join(" ").trim();
    const normalizedTranscript = normalizeTranscriptAntiRepetition(transcripts.map((chunk) => chunk.text).join(" "));

    return {
      sourceAudioRef: args.sourceAudioRef,
      language: args.language ?? "ru",
      chunks: transcripts,
      rawTranscript,
      normalizedTranscript,
      createdAt: new Date().toISOString(),
    };
  }

  async embedText(args: {
    text: string;
    namespace: string;
  }): Promise<EmbeddingArtifact> {
    if (!this.isConfigured()) {
      throw new Error("GigaChat embeddings are not configured.");
    }

    const chunks = splitTextByChars(args.text, EMBEDDING_CHUNK_MAX_CHARS);
    const vectors: EmbeddingChunkVector[] = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const vector = await this.requestWithRetry<number[]>(async () => {
        const token = await this.getAccessToken();
        const response = await fetch(`${this.config.baseURL}/embeddings`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.embeddingsModel || this.config.model,
            input: chunks[i],
          }),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`GigaChat embeddings failed (${response.status}): ${text}`);
        }
        const parsed = (await response.json()) as {
          data?: Array<{ embedding?: number[] }>;
          embedding?: number[];
        };
        const embedding = parsed.embedding ?? parsed.data?.[0]?.embedding;
        if (!embedding?.length) throw new Error("GigaChat embeddings returned empty vector");
        return embedding;
      });
      vectors.push({
        chunkIndex: i,
        text: chunks[i],
        vector,
      });
    }

    return {
      modelId: this.config.embeddingsModel || this.config.model || "gigachat-embeddings",
      namespace: args.namespace,
      chunks: vectors,
      pooledVector: averageVectors(vectors.map((item) => item.vector)),
      createdAt: new Date().toISOString(),
    };
  }

  private async requestWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= DEFAULT_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt === DEFAULT_RETRY_ATTEMPTS) break;
        await sleep(attempt * 500);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async getAccessToken(): Promise<string> {
    if (this.config.accessToken) return this.config.accessToken;

    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 10_000) {
      return this.tokenCache.token;
    }

    if (!this.config.authURL || !this.config.clientId || !this.config.clientSecret) {
      throw new Error("GigaChat auth credentials are missing.");
    }

    const response = await fetch(this.config.authURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: this.config.scope,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GigaChat auth failed (${response.status}): ${text}`);
    }

    const parsed = (await response.json()) as {
      access_token?: string;
      expires_at?: number;
      expires_in?: number;
    };
    if (!parsed.access_token) throw new Error("GigaChat auth response missing access_token");
    const expiresAt = parsed.expires_at
      ? parsed.expires_at * 1000
      : Date.now() + (parsed.expires_in ?? 1800) * 1000;
    this.tokenCache = {
      token: parsed.access_token,
      expiresAt,
    };
    return parsed.access_token;
  }
}

function splitBuffer(buffer: Buffer, chunkSize: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length)));
  }
  return chunks.length ? chunks : [buffer];
}

function inferPcmChunkSize(totalSize: number, chunkSeconds: number): number {
  const approxChunks = Math.max(1, Math.ceil(totalSize / (16000 * 2 * chunkSeconds)));
  return Math.max(4000, Math.ceil(totalSize / approxChunks));
}

function splitTextByChars(text: string, maxChars: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];
  const chunks: string[] = [];
  for (let offset = 0; offset < normalized.length; offset += maxChars) {
    chunks.push(normalized.slice(offset, offset + maxChars));
  }
  return chunks;
}

function normalizeSttChunk(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeTranscriptAntiRepetition(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  // Collapse immediate repeated 3+-token windows: "давайте посмотрим давайте посмотрим..."
  let result = normalized;
  const windows = [5, 4, 3];
  for (const size of windows) {
    const pattern = new RegExp(`\\b((?:\\S+\\s+){${size - 1}}\\S+)\\b(?:\\s+\\1\\b)+`, "gi");
    result = result.replace(pattern, "$1");
  }

  // Remove long repeated single tokens.
  result = result.replace(/\b(\S+)(?:\s+\1){3,}\b/gi, "$1");
  return result.trim();
}

function averageVectors(vectors: number[][]): number[] {
  if (!vectors.length) return [];
  const dimensions = vectors[0]?.length ?? 0;
  if (!dimensions) return [];
  const sums = new Array<number>(dimensions).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dimensions; i += 1) {
      sums[i] += vector[i] ?? 0;
    }
  }
  return sums.map((value) => value / vectors.length);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
