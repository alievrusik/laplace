import { BaseCritic, type CriticDeps } from "./base.js";
import type { CriticReport, IdeaInput } from "../types.js";
import type { TavilyClient } from "../grounding/tavily.js";
import { validatorPrompts } from "../prompts.js";

interface LegalDeps extends CriticDeps {
  tavily: TavilyClient;
}

export class LegalCritic extends BaseCritic {
  readonly role = "legal" as const;
  protected override preferAnthropic = true;

  constructor(private readonly legalDeps: LegalDeps) {
    super(legalDeps);
  }

  async evaluate(idea: IdeaInput): Promise<CriticReport> {
    const hits = await this.legalDeps.tavily.batch([
      `${idea.rawPrompt} GDPR AI compliance`,
      `${idea.rawPrompt} 152-ФЗ персональные данные`,
      `${idea.rawPrompt} IP legal risk`,
    ], 5);
    return this.completeReport(
      [
        validatorPrompts.legalCritic.system,
        `web_search_results=${JSON.stringify(hits.slice(0, 12))}`,
      ].join("\n"),
      idea.rawPrompt,
    );
  }
}
