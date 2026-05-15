import { ZodError } from "zod";
import type { LaplaceLlm } from "../../llm/laplaceLlm.js";
import { CriticReportSchema, type CriticReport, type CriticRole, type IdeaInput } from "../types.js";
import type { AnthropicLikeClient } from "../grounding/anthropicClient.js";

export interface CriticDeps {
  laplaceLlm: LaplaceLlm;
  anthropic?: AnthropicLikeClient;
}

export abstract class BaseCritic {
  abstract readonly role: CriticRole;
  protected preferAnthropic = false;

  constructor(protected readonly deps: CriticDeps) {}

  abstract evaluate(idea: IdeaInput): Promise<CriticReport>;

  protected get llm() {
    if (this.preferAnthropic && this.deps.anthropic) return this.deps.anthropic;
    return this.deps.laplaceLlm;
  }

  protected abstain(reason: string): CriticReport {
    return {
      role: this.role,
      score: 5,
      confidence: 0.2,
      summary: `Воздержание: ${reason}`,
      findings: [],
      recommendations: [],
      abstained: true,
    };
  }

  protected async completeReport(systemPrompt: string, userPrompt: string): Promise<CriticReport> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const raw = await this.llm.completeJson<unknown>([
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ]);
        const parsed = CriticReportSchema.parse({
          ...(raw as Record<string, unknown>),
          role: this.role,
        });
        const withCitationDiscipline = this.enforceCitationDiscipline(parsed);
        if (withCitationDiscipline.confidence < 0.4) {
          return { ...withCitationDiscipline, abstained: true };
        }
        return withCitationDiscipline;
      } catch (error) {
        lastError = error;
        if (!(error instanceof ZodError)) break;
      }
    }
    return this.abstain(
      lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error"),
    );
  }

  protected enforceCitationDiscipline(report: CriticReport): CriticReport {
    return {
      ...report,
      findings: report.findings.map((finding) => {
        if (finding.severity === "blocker" && finding.citations.length === 0) {
          return {
            ...finding,
            severity: "warn",
            rationale: `${finding.rationale} [downgraded: no citation]`,
          };
        }
        return finding;
      }),
    };
  }
}
