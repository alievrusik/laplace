import fs from "node:fs/promises";
import path from "node:path";
import type { LaplaceLlm } from "../llm/laplaceLlm.js";
import type { AnthropicLikeClient } from "./grounding/anthropicClient.js";
import { StaticAnalyzer } from "./staticAnalysis.js";
import { EmpiricalValidator } from "./empirical/empiricalValidator.js";
import type { TavilyClient } from "./grounding/tavily.js";
import {
  PrototypeValidationReportSchema,
  type PrototypeValidationReport,
  type StaticAnalysisIssue,
} from "./types.js";

export interface PrototypeValidationInput {
  originalIdea: string;
  enrichedPrompt: string;
  projectDir: string;
  previewUrl?: string;
  onProgress?: (message: string) => Promise<void> | void;
}

export class PrototypeValidator {
  private readonly staticAnalyzer = new StaticAnalyzer();

  constructor(
    private readonly deps: {
      laplaceLlm: LaplaceLlm;
      anthropic?: AnthropicLikeClient;
      tavily: TavilyClient;
    },
  ) {}

  async validate(input: PrototypeValidationInput): Promise<PrototypeValidationReport> {
    const staticIssues = await this.staticAnalyzer.analyze(input.projectDir);
    const hasHardStaticIssue = staticIssues.some((item) => item.category === "syntax_error" || item.category === "type_error");
    const hasPlaceholders = staticIssues.some((item) => item.category === "todo_in_critical_path" || item.category === "placeholder_logic");

    const codeDump = await this.collectCodeDump(input.projectDir);
    const llm = this.deps.anthropic ?? this.deps.laplaceLlm;
    const llmReview: Partial<PrototypeValidationReport> = await llm.completeJson<Partial<PrototypeValidationReport>>([
      {
        role: "system",
        content: [
          "Ты Principal Engineer + Product Manager.",
          "Проверь соответствие прототипа исходной задумке.",
          "Верни JSON со схемой PrototypeValidationReport.",
          "Если есть syntax/type errors, coherenceScore должен быть <= 4 и needsRefinement=true.",
          "Если есть critical TODO/placeholder, coherenceScore <= 6.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          originalIdea: input.originalIdea,
          enrichedPrompt: input.enrichedPrompt,
          staticIssues,
          codeDump,
        }),
      },
    ]).catch(() => ({} as Partial<PrototypeValidationReport>));

    const empirical = await new EmpiricalValidator({
      llm: this.deps.laplaceLlm,
      anthropic: this.deps.anthropic,
      tavily: this.deps.tavily,
    }).validate({
      originalIdea: input.originalIdea,
      enrichedPrompt: input.enrichedPrompt,
      previewUrl: input.previewUrl,
      projectDir: input.projectDir,
      onProgress: input.onProgress,
    });

    let coherenceScore = clampInt(llmReview.coherenceScore, 5, 0, 10);
    if (hasHardStaticIssue) coherenceScore = Math.min(coherenceScore, 4);
    else if (hasPlaceholders) coherenceScore = Math.min(coherenceScore, 6);

    let needsRefinement = Boolean(llmReview.needsRefinement || hasHardStaticIssue || hasPlaceholders);
    let refinementPrompt = typeof llmReview.refinementPrompt === "string" ? llmReview.refinementPrompt : undefined;

    if (empirical.status === "completed" && empirical.report.verdict === "broken") {
      needsRefinement = true;
      coherenceScore = Math.min(coherenceScore, 4);
      const topFailures = empirical.report.topFailures.slice(0, 3).map((item) => `- sample ${item.sampleId}: status=${item.status}`).join("\n");
      refinementPrompt = [
        refinementPrompt ?? "Исправить дефекты, выявленные в empirical audit.",
        "",
        "Критичные empirical fail-кейсы:",
        topFailures || "- нет деталей",
      ].join("\n");
    } else if (empirical.status === "completed" && empirical.report.verdict === "needs_iteration") {
      needsRefinement = true;
    }

    const report: PrototypeValidationReport = {
      matchesIntent: Boolean(llmReview.matchesIntent),
      intentAlignmentScore: clampInt(llmReview.intentAlignmentScore, 5, 0, 10),
      coherenceScore,
      completenessScore: clampInt(llmReview.completenessScore, 5, 0, 10),
      staticAnalysisIssues: staticIssues,
      findings: Array.isArray(llmReview.findings) ? llmReview.findings : inferFindingsFromStatic(staticIssues),
      needsRefinement,
      refinementPrompt,
      executiveSummary: typeof llmReview.executiveSummary === "string" && llmReview.executiveSummary.trim()
        ? llmReview.executiveSummary.trim()
        : "Аудит завершен. Проверьте consistency, стабильность и соответствие сценариям.",
      empiricalValidation: empirical,
    };

    return PrototypeValidationReportSchema.parse(report);
  }

  private async collectCodeDump(projectDir: string): Promise<string> {
    const MAX_CHARS = 180_000;
    const files: string[] = [];
    await walk(projectDir, files);
    let total = 0;
    const chunks: string[] = [];
    for (const fullPath of files) {
      if (total >= MAX_CHARS) break;
      const rel = path.relative(projectDir, fullPath);
      const content = await fs.readFile(fullPath, "utf8").catch(() => "");
      if (!content) continue;
      const wrapped = `\n=== ${rel} ===\n${content}`;
      if (total + wrapped.length > MAX_CHARS) {
        chunks.push(wrapped.slice(0, MAX_CHARS - total));
        total = MAX_CHARS;
      } else {
        chunks.push(wrapped);
        total += wrapped.length;
      }
    }
    return chunks.join("\n");
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function inferFindingsFromStatic(staticIssues: StaticAnalysisIssue[]) {
  return staticIssues.slice(0, 8).map((issue) => ({
    severity: issue.category === "syntax_error" || issue.category === "type_error" ? "blocker" as const : "warn" as const,
    statement: `${issue.category}: ${issue.filePath}`,
    rationale: issue.message,
    citations: [],
  }));
}

async function walk(projectDir: string, acc: string[], current = projectDir): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (["node_modules", ".git", "dist", ".next", "build", ".vercel"].includes(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(projectDir, acc, fullPath);
    } else if (/\.(ts|tsx|js|jsx|md|json|yaml|yml|html|css|scss)$/i.test(entry.name)) {
      acc.push(fullPath);
    }
  }
}
