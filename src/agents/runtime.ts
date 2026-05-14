import { Agent, CursorAgentError } from "@cursor/sdk";
import type { SDKMessage } from "@cursor/sdk";

export class AgentRuntimeStartupError extends Error {
  constructor(message: string, readonly causeError?: unknown) {
    super(message);
    this.name = "AgentRuntimeStartupError";
  }
}

export type RuntimeRunStatus = "finished" | "error" | "cancelled";

export interface RuntimeRunResult {
  id: string;
  status: RuntimeRunStatus;
  result?: string;
}

export interface RuntimeRun {
  id: string;
  agentId: string;
  supportsStream: boolean;
  wait(): Promise<RuntimeRunResult>;
  stream(): AsyncGenerator<string, void>;
}

export interface RuntimeSession {
  send(prompt: string): Promise<RuntimeRun>;
  dispose(): Promise<void>;
}

export interface AgentRuntime {
  createSession(args: { cwd: string; modelId: string }): Promise<RuntimeSession>;
}

export class CursorSdkAgentRuntime implements AgentRuntime {
  constructor(
    private readonly config: {
      apiKey: string;
    },
  ) {}

  async createSession(args: { cwd: string; modelId: string }): Promise<RuntimeSession> {
    try {
      const agent = await Agent.create({
        apiKey: this.config.apiKey,
        model: { id: args.modelId },
        local: { cwd: args.cwd },
      });

      return new CursorRuntimeSession(agent);
    } catch (error) {
      if (error instanceof CursorAgentError) {
        throw new AgentRuntimeStartupError(`Cursor runtime startup failed: ${error.message}`, error);
      }
      throw error;
    }
  }
}

class CursorRuntimeSession implements RuntimeSession {
  constructor(
    private readonly agent: Awaited<ReturnType<typeof Agent.create>>,
  ) {}

  async send(prompt: string): Promise<RuntimeRun> {
    try {
      const run = await this.agent.send(prompt);
      return new CursorRuntimeRun(run);
    } catch (error) {
      if (error instanceof CursorAgentError) {
        throw new AgentRuntimeStartupError(`Cursor runtime send failed: ${error.message}`, error);
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    await this.agent[Symbol.asyncDispose]();
  }
}

class CursorRuntimeRun implements RuntimeRun {
  readonly id: string;
  readonly agentId: string;
  readonly supportsStream: boolean;

  constructor(
    private readonly run: Awaited<ReturnType<Awaited<ReturnType<typeof Agent.create>>["send"]>>,
  ) {
    this.id = run.id;
    this.agentId = run.agentId;
    this.supportsStream = run.supports("stream");
  }

  async wait(): Promise<RuntimeRunResult> {
    const result = await this.run.wait();
    return {
      id: result.id,
      status: result.status as RuntimeRunStatus,
      result: result.result,
    };
  }

  async *stream(): AsyncGenerator<string, void> {
    if (!this.supportsStream) return;

    for await (const event of this.run.stream()) {
      const line = summarizeSdkMessage(event);
      if (line) yield line;
    }
  }
}

function summarizeSdkMessage(event: SDKMessage): string | undefined {
  if (event.type === "status") {
    return `Cursor status: ${event.status}${event.message ? ` - ${event.message}` : ""}`;
  }

  if (event.type === "task") {
    return event.text ? `Cursor task: ${event.text.slice(0, 500)}` : undefined;
  }

  if (event.type === "tool_call") {
    return `Cursor tool ${event.name}: ${event.status}`;
  }

  if (event.type === "assistant") {
    const text = event.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    return text ? `Cursor: ${text.slice(0, 500)}` : undefined;
  }

  return undefined;
}
