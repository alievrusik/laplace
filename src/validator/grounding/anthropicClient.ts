import https from "node:https";
import fs from "node:fs/promises";
import { HttpsProxyAgent } from "https-proxy-agent";
import { FileCache } from "../cache.js";

export interface AnthropicLikeClient {
  complete(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>): Promise<string>;
  completeJson<T>(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>): Promise<T>;
}

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  proxyUrl?: string;
  proxyCaCertPath?: string;
  proxyCaCertBase64?: string;
  maxTokens?: number;
  cache?: FileCache;
}

export class AnthropicClient implements AnthropicLikeClient {
  private agentPromise: Promise<https.Agent | undefined> | undefined;

  constructor(private readonly config: AnthropicConfig) {}

  async complete(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>): Promise<string> {
    const cacheKey = JSON.stringify({ m: this.config.model, messages });
    const cached = await this.config.cache?.get<string>("anthropic-complete", cacheKey);
    if (cached) return cached;

    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const conversation = messages.filter((m) => m.role !== "system").map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: [{ type: "text", text: m.content }],
    }));

    const agent = await this.resolveAgent();
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": this.config.apiKey,
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens ?? 16384,
        system: system || undefined,
        messages: conversation,
      }),
      ...(agent ? { dispatcher: agent as never } : {}),
    });
    if (!response.ok) {
      throw new Error(`Anthropic error ${response.status}: ${await response.text()}`);
    }
    const json = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      stop_reason?: string;
    };
    const text = (json.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
    if (!text) throw new Error("Anthropic returned empty content");
    if (json.stop_reason === "max_tokens") {
      console.warn(`[anthropic] response reached max_tokens=${this.config.maxTokens ?? 16384}`);
    }
    await this.config.cache?.set("anthropic-complete", cacheKey, text);
    return text;
  }

  async completeJson<T>(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>): Promise<T> {
    let output = await this.complete(messages);
    try {
      return JSON.parse(extractJson(output)) as T;
    } catch {
      output = await this.complete([
        ...messages,
        {
          role: "system",
          content:
            "Return only valid compact JSON. No markdown. Keep arrays <= 8 items and long strings <= 600 chars.",
        },
      ]);
      try {
        return JSON.parse(extractJson(output)) as T;
      } catch (retryError) {
        const salvaged = trySalvageBalanced(output);
        if (salvaged) {
          return JSON.parse(salvaged) as T;
        }
        throw retryError;
      }
    }
  }

  private async resolveAgent(): Promise<https.Agent | undefined> {
    if (!this.config.proxyUrl) return undefined;
    if (!this.agentPromise) {
      this.agentPromise = this.createProxyAgent();
    }
    return this.agentPromise;
  }

  private async createProxyAgent(): Promise<https.Agent> {
    let ca: string | Buffer | undefined;
    if (this.config.proxyCaCertBase64) {
      ca = Buffer.from(this.config.proxyCaCertBase64, "base64");
    } else if (this.config.proxyCaCertPath) {
      ca = await fs.readFile(this.config.proxyCaCertPath);
    }
    return new HttpsProxyAgent(this.config.proxyUrl!, {
      ...(ca ? { ca } : {}),
    });
  }
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const objStart = trimmed.indexOf("{");
  const arrStart = trimmed.indexOf("[");
  if (objStart < 0 && arrStart < 0) {
    throw new Error(`Response has no JSON payload: ${trimmed.slice(0, 300)}`);
  }
  const start = objStart < 0 ? arrStart : arrStart < 0 ? objStart : Math.min(objStart, arrStart);
  return trimmed.slice(start);
}

function trySalvageBalanced(text: string): string | null {
  const trimmed = text.trim();
  const objStart = trimmed.indexOf("{");
  const arrStart = trimmed.indexOf("[");
  if (objStart < 0 && arrStart < 0) return null;
  const start = objStart < 0 ? arrStart : arrStart < 0 ? objStart : Math.min(objStart, arrStart);
  const opener = trimmed[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === opener) depth += 1;
    if (ch === closer) {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}
