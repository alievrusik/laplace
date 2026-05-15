import { BaseCritic, type CriticDeps } from "./base.js";
import type { CriticReport, IdeaInput } from "../types.js";

export class ResourcesCritic extends BaseCritic {
  readonly role = "resources" as const;

  constructor(deps: CriticDeps) {
    super(deps);
  }

  async evaluate(idea: IdeaInput): Promise<CriticReport> {
    return this.completeReport(
      "Ты COO. Оцени ресурсы, бюджет, комплаенс (152-ФЗ/GDPR), план команды. Верни строго CriticReport JSON.",
      idea.rawPrompt,
    );
  }
}
