import { BaseCritic, type CriticDeps } from "./base.js";
import type { CriticReport, IdeaInput } from "../types.js";

export class ComplexityCritic extends BaseCritic {
  readonly role = "complexity" as const;

  constructor(deps: CriticDeps) {
    super(deps);
  }

  async evaluate(idea: IdeaInput): Promise<CriticReport> {
    return this.completeReport(
      "Ты VP of Engineering. Оцени сложность, операционные риски, масштабирование. Верни строго CriticReport JSON.",
      idea.rawPrompt,
    );
  }
}
