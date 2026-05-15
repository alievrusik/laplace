import { BaseCritic, type CriticDeps } from "./base.js";
import type { CriticReport, IdeaInput } from "../types.js";

export class TeamCritic extends BaseCritic {
  readonly role = "team" as const;

  constructor(deps: CriticDeps) {
    super(deps);
  }

  async evaluate(idea: IdeaInput): Promise<CriticReport> {
    return this.completeReport(
      "Ты Talent Partner. Оцени founder-market fit, командные пробелы и hiring-план. Верни строго CriticReport JSON.",
      idea.rawPrompt,
    );
  }
}
