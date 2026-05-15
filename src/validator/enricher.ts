import type { LaplaceLlm } from "../llm/laplaceLlm.js";
import type { AnthropicLikeClient } from "./grounding/anthropicClient.js";
import type { CriticReport, IdeaInput } from "./types.js";
import { validatorPrompts } from "./prompts.js";

export class PromptEnricher {
  constructor(private readonly deps: { laplaceLlm: LaplaceLlm; anthropic?: AnthropicLikeClient }) {}

  async enrich(args: { idea: IdeaInput; criticReports: CriticReport[] }): Promise<string> {
    const llm = this.deps.anthropic ?? this.deps.laplaceLlm;
    const response = await llm.complete([
      {
        role: "system",
        content: validatorPrompts.enricher.system,
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
