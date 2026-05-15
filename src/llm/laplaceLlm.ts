import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export class LaplaceLlm {
  private readonly client: OpenAI;

  constructor(
    private readonly config: {
      baseURL: string;
      apiKey: string;
      model: string;
      disableReasoning: boolean;
    },
  ) {
    this.client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    });
  }

  async complete(messages: ChatCompletionMessageParam[]): Promise<string> {
    const request = {
      model: this.config.model,
      messages,
      max_tokens: 512,
      ...(this.config.disableReasoning
        ? {
            chat_template_kwargs: {
              enable_thinking: false,
            },
          }
        : {}),
    };

    const completion = await this.client.chat.completions.create(request as never);
    const message = completion.choices[0]?.message as
      | { content?: string | null; reasoning?: string | null }
      | undefined;
    const primaryContent = sanitizeContent(message?.content ?? "");

    if (primaryContent) return primaryContent;

    if (!this.config.disableReasoning) {
      // Some local reasoning models can spend the whole token budget on thought
      // and return an empty `content`. Retry once with thinking disabled.
      const fallbackCompletion = await this.client.chat.completions.create(
        {
          ...request,
          chat_template_kwargs: {
            enable_thinking: false,
          },
        } as never,
      );
      const fallbackMessage = fallbackCompletion.choices[0]?.message as
        | { content?: string | null }
        | undefined;
      return sanitizeContent(fallbackMessage?.content ?? "");
    }

    return "";
  }

  async completeJson<T>(messages: ChatCompletionMessageParam[]): Promise<T> {
    const systemMessages = messages
      .filter((message) => message.role === "system")
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .filter(Boolean);
    const nonSystemMessages = messages.filter((message) => message.role !== "system");

    const text = await this.complete([
      {
        role: "system",
        content: [
          ...systemMessages,
          "Return only valid JSON. Do not wrap it in Markdown.",
        ].join("\n\n"),
      },
      ...nonSystemMessages,
    ]);

    return JSON.parse(extractJson(text)) as T;
  }
}

function sanitizeContent(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match?.[1]) return match[1].trim();

  throw new Error(`LLM response did not contain JSON: ${text.slice(0, 200)}`);
}
