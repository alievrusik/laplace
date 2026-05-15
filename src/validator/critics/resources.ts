import { BaseCritic, type CriticDeps } from "./base.js";
import type { CriticReport, IdeaInput } from "../types.js";
import { validatorPrompts } from "../prompts.js";

export class ResourcesCritic extends BaseCritic {
  readonly role = "resources" as const;

  constructor(deps: CriticDeps) {
    super(deps);
  }

  async evaluate(idea: IdeaInput): Promise<CriticReport> {
    return this.completeReport(
      validatorPrompts.resourcesCritic.system,
      idea.rawPrompt,
    );
  }
}
