import type { LaplaceLlm } from "../llm/laplaceLlm.js";
import type { AnthropicLikeClient } from "./grounding/anthropicClient.js";
import { ArbitrationReportSchema, type ArbitrationReport, type CriticReport } from "./types.js";
import { validatorPrompts } from "./prompts.js";

export class Arbitrator {
  constructor(private readonly deps: { laplaceLlm: LaplaceLlm; anthropic?: AnthropicLikeClient }) {}

  async arbitrate(reports: CriticReport[]): Promise<ArbitrationReport> {
    const llm = this.deps.anthropic ?? this.deps.laplaceLlm;
    const raw = await llm.completeJson<unknown>([
      {
        role: "system",
        content: validatorPrompts.arbitrator.system,
      },
      {
        role: "user",
        content: JSON.stringify(reports.map((r) => ({ role: r.role, score: r.score, summary: r.summary }))),
      },
    ]).catch(() => ({}));
    return ArbitrationReportSchema.parse(raw);
  }
}
