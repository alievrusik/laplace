import { BaseCritic, type CriticDeps } from "./base.js";
import type { CriticReport, IdeaInput } from "../types.js";
import type { TavilyClient } from "../grounding/tavily.js";

interface InvestDeps extends CriticDeps {
  tavily: TavilyClient;
}

export class InvestCritic extends BaseCritic {
  readonly role = "invest" as const;
  protected override preferAnthropic = true;

  constructor(private readonly investDeps: InvestDeps) {
    super(investDeps);
  }

  async evaluate(idea: IdeaInput): Promise<CriticReport> {
    const hits = await this.investDeps.tavily.batch([
      `${idea.rawPrompt} TAM SAM SOM`,
      `${idea.rawPrompt} venture funding`,
      `${idea.rawPrompt} benchmark startup`,
    ], 5);
    return this.completeReport(
      [
        "Ты VC Partner.",
        "Оцени fundability, TAM, growth, deal signals.",
        "Факты только с citations из web_search_results.",
        "Верни строго CriticReport JSON.",
        `web_search_results=${JSON.stringify(hits.slice(0, 12))}`,
      ].join("\n"),
      idea.rawPrompt,
    );
  }
}
