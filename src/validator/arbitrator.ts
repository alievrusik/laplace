import type { LaplaceLlm } from "../llm/laplaceLlm.js";
import type { AnthropicLikeClient } from "./grounding/anthropicClient.js";
import { ArbitrationReportSchema, type ArbitrationReport, type CriticReport } from "./types.js";

export class Arbitrator {
  constructor(private readonly deps: { laplaceLlm: LaplaceLlm; anthropic?: AnthropicLikeClient }) {}

  async arbitrate(reports: CriticReport[]): Promise<ArbitrationReport> {
    const llm = this.deps.anthropic ?? this.deps.laplaceLlm;
    const raw = await llm.completeJson<unknown>([
      {
        role: "system",
        content: "Найди numeric/semantic contradictions и consensus между отчётами критиков. Верни строго ArbitrationReport JSON.",
      },
      {
        role: "user",
        content: JSON.stringify(reports.map((r) => ({ role: r.role, score: r.score, summary: r.summary }))),
      },
    ]).catch(() => ({}));
    return ArbitrationReportSchema.parse(raw);
  }
}
