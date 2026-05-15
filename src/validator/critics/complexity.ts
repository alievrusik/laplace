import { BaseCritic, type CriticDeps } from "./base.js";
import type { CriticReport, IdeaInput } from "../types.js";
import { validatorPrompts } from "../prompts.js";

export class ComplexityCritic extends BaseCritic {
  readonly role = "complexity" as const;

  constructor(deps: CriticDeps) {
    super(deps);
  }

  async evaluate(idea: IdeaInput): Promise<CriticReport> {
    return this.completeReport(
      validatorPrompts.complexityCritic.system,
      idea.rawPrompt,
    );
  }
}
