import fs from "node:fs/promises";
import path from "node:path";
import type { LaplaceLlm } from "../../llm/laplaceLlm.js";
import type { AnthropicLikeClient } from "../grounding/anthropicClient.js";
import type { TavilyClient } from "../grounding/tavily.js";
import {
  EmpiricalValidationResultSchema,
  type EmpiricalValidationResult,
  type EmpiricalRunItem,
  type EmpiricalSample,
  type OracleComparison,
} from "../types.js";
import { validatorPrompts } from "../prompts.js";

const TOTAL_SAMPLES = 30;
const GLOBAL_TIMEOUT_MS = 5 * 60 * 1000;

export class EmpiricalValidator {
  constructor(
    private readonly deps: {
      llm: LaplaceLlm;
      anthropic?: AnthropicLikeClient;
      tavily: TavilyClient;
    },
  ) {}

  async validate(args: {
    originalIdea: string;
    enrichedPrompt: string;
    previewUrl?: string;
    projectDir: string;
    onProgress?: (message: string) => Promise<void> | void;
  }): Promise<EmpiricalValidationResult> {
    if (!this.deps.anthropic || !this.deps.tavily.isEnabled()) {
      return EmpiricalValidationResultSchema.parse({ status: "skipped", reason: "Anthropic or Tavily is not configured." });
    }
    if (!args.previewUrl) {
      return EmpiricalValidationResultSchema.parse({ status: "failed_no_preview", reason: "Preview URL not found." });
    }

    const start = Date.now();
    const timeoutGuard = setTimeout(() => undefined, GLOBAL_TIMEOUT_MS);
    try {
      const warmed = await this.warmup(args.previewUrl);
      if (!warmed) {
        return EmpiricalValidationResultSchema.parse({ status: "failed_no_preview", reason: "Preview warmup failed after retries." });
      }

      const endpoint = await this.detectEndpoint(args.projectDir, args.previewUrl);
      if (!endpoint) {
        return EmpiricalValidationResultSchema.parse({ status: "failed_no_endpoint", reason: "Cannot infer API endpoint." });
      }

      const snippets = await this.researchSnippets(args.enrichedPrompt);
      if (snippets.length < 5) {
        return EmpiricalValidationResultSchema.parse({ status: "failed_no_dataset", reason: "Not enough grounding snippets." });
      }

      const samples = await this.synthesizeSamples(args.enrichedPrompt, snippets, endpoint.example);
      if (!samples.length) {
        return EmpiricalValidationResultSchema.parse({ status: "failed_no_dataset", reason: "No synthesized samples." });
      }

      const runs = await this.runSamples(samples, endpoint.url, endpoint.method, args.onProgress);
      const oracle = await this.compareWithOracle(args.enrichedPrompt, runs, endpoint.inputShape);
      if (!oracle) {
        return EmpiricalValidationResultSchema.parse({ status: "failed_oracle", reason: "Oracle comparison failed." });
      }

      const completed = aggregateEmpirical({
        runs,
        oracle,
        durationSec: (Date.now() - start) / 1000,
      });
      return EmpiricalValidationResultSchema.parse({ status: "completed", report: completed });
    } finally {
      clearTimeout(timeoutGuard);
      if (Date.now() - start > GLOBAL_TIMEOUT_MS) {
        return EmpiricalValidationResultSchema.parse({ status: "failed_timeout", reason: "Empirical validation timed out." });
      }
    }
  }

  private async warmup(previewUrl: string): Promise<boolean> {
    const delays = [10_000, 20_000, 30_000];
    for (let i = 0; i < delays.length; i += 1) {
      try {
        const response = await fetch(previewUrl);
        if (response.ok) return true;
      } catch {
        // continue
      }
      await new Promise((resolve) => setTimeout(resolve, delays[i]));
    }
    return false;
  }

  private async detectEndpoint(projectDir: string, previewUrl: string): Promise<{
    url: string;
    method: "GET" | "POST";
    contentType: string;
    inputShape: Record<string, unknown>;
    example: Record<string, unknown>;
  } | undefined> {
    const files = await collectCandidateFiles(projectDir);
    const readme = await fs.readFile(path.join(projectDir, "README.md"), "utf8").catch(() => "");
    const snippets = await Promise.all(files.slice(0, 8).map(async (file) => {
      const content = await fs.readFile(file, "utf8").catch(() => "");
      return { file: path.relative(projectDir, file), content: content.slice(0, 4000) };
    }));
    return this.deps.llm.completeJson<{
      url?: string;
      method?: "GET" | "POST";
      contentType?: string;
      inputShape?: Record<string, unknown>;
      example?: Record<string, unknown>;
    }>([
      {
        role: "system",
        content: validatorPrompts.empiricalEndpointDetection.system,
      },
      {
        role: "user",
        content: JSON.stringify({ previewUrl, readme: readme.slice(0, 5000), files: snippets }),
      },
    ]).then((payload) => {
      if (!payload.url || !payload.method) return undefined;
      return {
        url: payload.url.startsWith("http") ? payload.url : `${previewUrl.replace(/\/$/, "")}${payload.url.startsWith("/") ? payload.url : `/${payload.url}`}`,
        method: payload.method,
        contentType: payload.contentType ?? "application/json",
        inputShape: payload.inputShape ?? {},
        example: payload.example ?? {},
      };
    }).catch(() => undefined);
  }

  private async researchSnippets(prompt: string): Promise<Array<{ title: string; url: string; content: string }>> {
    const queries = await this.deps.llm.completeJson<{ queries?: string[] }>([
      { role: "system", content: "Сгенерируй 5 английских запросов для поиска данных/бенчмарков по идее. Верни JSON {queries:[...]}" },
      { role: "user", content: prompt },
    ]).then((r) => r.queries ?? []).catch(() => []);
    const hits = await this.deps.tavily.batch(queries.slice(0, 5), 5);
    const unique = new Map<string, { title: string; url: string; content: string }>();
    for (const hit of hits) {
      if (!unique.has(hit.url)) unique.set(hit.url, hit);
    }
    return [...unique.values()];
  }

  private async synthesizeSamples(
    enrichedPrompt: string,
    snippets: Array<{ title: string; url: string; content: string }>,
    endpointExample: Record<string, unknown>,
  ): Promise<EmpiricalSample[]> {
    return this.deps.llm.completeJson<{ samples?: EmpiricalSample[] }>([
      {
        role: "system",
        content: validatorPrompts.empiricalSampleSynthesis.system.replace("30", String(TOTAL_SAMPLES)),
      },
      {
        role: "user",
        content: JSON.stringify({ enrichedPrompt, snippets: snippets.slice(0, 12), endpointExample }),
      },
    ]).then((r) => (r.samples ?? []).slice(0, TOTAL_SAMPLES)).catch(() => []);
  }

  private async runSamples(
    samples: EmpiricalSample[],
    url: string,
    method: "GET" | "POST",
    onProgress?: (message: string) => Promise<void> | void,
  ): Promise<EmpiricalRunItem[]> {
    const concurrency = 5;
    const result: EmpiricalRunItem[] = [];
    let completed = 0;
    const queue = [...samples];
    const workers = Array.from({ length: concurrency }).map(async () => {
      while (queue.length) {
        const sample = queue.shift()!;
        const start = Date.now();
        let item: EmpiricalRunItem;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 45_000);
          const response = await fetch(url, {
            method,
            headers: { "Content-Type": "application/json" },
            body: method === "POST" ? JSON.stringify(sample.payload) : undefined,
            signal: controller.signal,
          });
          clearTimeout(timer);
          const rawResponse = await response.text();
          let parsedResponse: unknown;
          let schemaValid = false;
          try {
            parsedResponse = JSON.parse(rawResponse);
            schemaValid = typeof parsedResponse === "object" && parsedResponse !== null;
          } catch {
            parsedResponse = undefined;
          }
          item = {
            sampleId: sample.id,
            payload: sample.payload,
            status: response.ok ? "ok" : "http_error",
            latencyMs: Date.now() - start,
            httpStatus: response.status,
            rawResponse: rawResponse.slice(0, 4000),
            parsedResponse,
            schemaValid,
          };
        } catch (error) {
          item = {
            sampleId: sample.id,
            payload: sample.payload,
            status: error instanceof Error && error.name === "AbortError" ? "timeout" : "parse_error",
            latencyMs: Date.now() - start,
            schemaValid: false,
          };
        }
        result.push(item);
        completed += 1;
        if (completed % 10 === 0) {
          await onProgress?.(`empirical progress: ${completed}/${samples.length}`);
        }
      }
    });
    await Promise.all(workers);
    return result;
  }

  private async compareWithOracle(
    enrichedPrompt: string,
    runs: EmpiricalRunItem[],
    inputShape: Record<string, unknown>,
  ): Promise<OracleComparison[] | undefined> {
    if (!this.deps.anthropic) return undefined;
    const chunks: EmpiricalRunItem[][] = [];
    for (let i = 0; i < runs.length; i += 10) chunks.push(runs.slice(i, i + 10));
    const comparisons: OracleComparison[] = [];
    let failed = 0;
    for (const chunk of chunks) {
      try {
        const response = await this.deps.anthropic.completeJson<{ comparisons?: OracleComparison[] }>([
          {
            role: "system",
            content: validatorPrompts.empiricalOracle.system,
          },
          {
            role: "user",
            content: JSON.stringify({ enrichedPrompt, inputShape, runs: chunk }),
          },
        ]);
        comparisons.push(...(response.comparisons ?? []));
      } catch {
        failed += 1;
      }
    }
    if (failed >= 2) return undefined;
    return comparisons;
  }
}

function aggregateEmpirical(args: {
  runs: EmpiricalRunItem[];
  oracle: OracleComparison[];
  durationSec: number;
}) {
  const successful = args.runs.filter((item) => item.status === "ok");
  const coverage = successful.length / Math.max(1, args.runs.length);
  const schemaCompliance = successful.filter((item) => item.schemaValid).length / Math.max(1, successful.length);
  const latencies = successful.map((item) => item.latencyMs).sort((a, b) => a - b);
  const agreementValues = args.oracle.map((item) => item.agreement).sort((a, b) => a - b);
  const meanAgreement = agreementValues.reduce((sum, item) => sum + item, 0) / Math.max(1, agreementValues.length);
  const failureBreakdown: Record<string, number> = {};
  for (const item of args.oracle) {
    if (!item.failureCategory) continue;
    failureBreakdown[item.failureCategory] = (failureBreakdown[item.failureCategory] ?? 0) + 1;
  }

  const groundTruth = args.oracle.filter((item) => typeof item.isCorrect === "boolean");
  const groundTruthAccuracy = groundTruth.length
    ? groundTruth.filter((item) => item.isCorrect).length / groundTruth.length
    : undefined;

  let verdict: "production_ready" | "demo_ready" | "needs_iteration" | "broken" = "needs_iteration";
  if (coverage < 0.5 || meanAgreement < 0.3) verdict = "broken";
  else if (coverage < 0.8 || meanAgreement < 0.6) verdict = "needs_iteration";
  else if (groundTruthAccuracy !== undefined && groundTruthAccuracy >= 0.8) verdict = "production_ready";
  else verdict = "demo_ready";

  return {
    totalSamples: args.runs.length,
    coverage,
    latency: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies[latencies.length - 1] ?? 0,
    },
    schemaCompliance,
    agreement: {
      mean: meanAgreement,
      median: percentile(agreementValues, 0.5),
      p25: percentile(agreementValues, 0.25),
      p75: percentile(agreementValues, 0.75),
    },
    groundTruthAccuracy,
    topFailures: args.runs.slice(0, 5),
    topSuccesses: successful.slice(0, 3),
    failureBreakdown,
    recommendations: [
      "Улучшить валидацию входных payload в API.",
      "Усилить schema-safe формат ответа endpoint.",
      "Добавить обработку edge/adversarial кейсов в server route.",
    ],
    verdict,
    approxCostUsd: 0.5,
    durationSec: args.durationSec,
  };
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const idx = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * p)));
  return values[idx];
}

async function collectCandidateFiles(projectDir: string): Promise<string[]> {
  const result: string[] = [];
  const pattern = /\/(api|app|pages|routes)\//;
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (/\.(ts|js|py)$/i.test(entry.name) && pattern.test(full)) {
        result.push(full);
      }
    }
  }
  await walk(projectDir);
  return result;
}
