import type { LaplaceLlm } from "../llm/laplaceLlm.js";
import type { AnthropicLikeClient } from "./grounding/anthropicClient.js";
import type { CriticReport, IdeaInput } from "./types.js";

export class PromptEnricher {
  constructor(private readonly deps: { laplaceLlm: LaplaceLlm; anthropic?: AnthropicLikeClient }) {}

  async enrich(args: { idea: IdeaInput; criticReports: CriticReport[] }): Promise<string> {
    const llm = this.deps.anthropic ?? this.deps.laplaceLlm;
    const response = await llm.complete([
      {
        role: "system",
        content:
          "Перепиши идею в production-ready brief: цель, input->output сценарий, acceptance criteria, ограничения, demo path, риски. Без markdown, без секретов.",
      },
      {
        role: "user",
        content: JSON.stringify({
          idea: args.idea.rawPrompt,
          criticHighlights: args.criticReports.map((r) => ({
            role: r.role,
            summary: r.summary,
            recommendations: r.recommendations.slice(0, 2),
          })),
        }),
      },
    ]).catch(() => "");
    return response.trim() || args.idea.rawPrompt;
  }
}
