import { FileCache } from "../cache.js";

export interface TavilySearchHit {
  title: string;
  url: string;
  content: string;
}

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

export class TavilyClient {
  constructor(
    private readonly config: {
      apiKey?: string;
      cache: FileCache;
    },
  ) {}

  isEnabled(): boolean {
    return Boolean(this.config.apiKey);
  }

  async search(query: string, maxResults = 5): Promise<TavilySearchHit[]> {
    if (!this.config.apiKey) return [];
    const trimmed = query.trim().slice(0, 380);
    if (!trimmed) return [];
    const cacheKey = `${trimmed}::${maxResults}`;
    const cached = await this.config.cache.get<TavilySearchHit[]>("tavily", cacheKey);
    if (cached) return cached;

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.config.apiKey,
        query: trimmed,
        max_results: maxResults,
      }),
    });
    if (!response.ok) {
      return [];
    }
    const json = (await response.json()) as TavilyResponse;
    const hits = (json.results ?? [])
      .map((item) => ({
        title: item.title ?? "Untitled",
        url: item.url ?? "",
        content: item.content ?? "",
      }))
      .filter((item) => item.url && item.content);
    await this.config.cache.set("tavily", cacheKey, hits);
    return hits;
  }

  async batch(queries: string[], maxResults = 5): Promise<TavilySearchHit[]> {
    const all = await Promise.all(queries.map((q) => this.search(q, maxResults)));
    return all.flat();
  }
}
