import type { LaplaceLlm } from "../llm/laplaceLlm.js";
import type { AnthropicLikeClient } from "./grounding/anthropicClient.js";
import { FinancialModelSchema, type CriticReport, type FinancialModel, type IdeaInput } from "./types.js";

export class FinancialModeler {
  constructor(private readonly deps: { laplaceLlm: LaplaceLlm; anthropic?: AnthropicLikeClient }) {}

  async build(args: { idea: IdeaInput; criticReports: CriticReport[] }): Promise<FinancialModel | undefined> {
    const llm = this.deps.anthropic ?? this.deps.laplaceLlm;
    const raw = await llm.completeJson<unknown>([
      {
        role: "system",
        content: "Построй финансовую модель TAM/SAM/SOM + unit economics + burn/runway. Минимум 5 assumptions. Верни строго FinancialModel JSON.",
      },
      {
        role: "user",
        content: JSON.stringify({
          idea: args.idea.rawPrompt,
          criticSummaries: args.criticReports.map((r) => ({ role: r.role, summary: r.summary })),
        }),
      },
    ]).catch(() => undefined);
    if (!raw) return undefined;
    const parsed = FinancialModelSchema.parse(raw);
    if (parsed.assumptions.length < 5) return undefined;
    return parsed;
  }
}
