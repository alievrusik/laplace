import { BaseCritic, type CriticDeps } from "./base.js";
import type { CriticReport, IdeaInput } from "../types.js";
import type { TavilyClient } from "../grounding/tavily.js";

interface MarketDeps extends CriticDeps {
  tavily: TavilyClient;
}

export class MarketCritic extends BaseCritic {
  readonly role = "market" as const;

  constructor(private readonly marketDeps: MarketDeps) {
    super(marketDeps);
  }

  async evaluate(idea: IdeaInput): Promise<CriticReport> {
    const queries = await this.deps.laplaceLlm.completeJson<{ queries?: string[] }>([
      { role: "system", content: "Верни JSON: {\"queries\":[3 коротких английских поисковых запроса по идее]}" },
      { role: "user", content: idea.rawPrompt },
    ]).then((r) => (r.queries ?? []).slice(0, 3)).catch(() => []);
    const hits = queries.length ? await this.marketDeps.tavily.batch(queries, 5) : [];
    return this.completeReport(
      [
        "Ты Senior Market Analyst.",
        "Нельзя делать factual claims без citations из web_search_results.",
        "Если grounding слабый, confidence <= 0.3.",
        "Верни строго CriticReport JSON.",
        `web_search_results=${JSON.stringify(hits.slice(0, 12))}`,
      ].join("\n"),
      idea.rawPrompt,
    );
  }
}
