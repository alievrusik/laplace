import { BaseCritic, type CriticDeps } from "./base.js";
import type { CriticReport, IdeaInput } from "../types.js";

export class TechCritic extends BaseCritic {
  readonly role = "tech" as const;

  constructor(deps: CriticDeps) {
    super(deps);
  }

  async evaluate(idea: IdeaInput): Promise<CriticReport> {
    return this.completeReport(
      "Ты Principal Engineer. Оцени реализуемость AI/ML прототипа. Верни строго CriticReport JSON.",
      idea.rawPrompt,
    );
  }
}
