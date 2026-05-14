import assert from "node:assert/strict";
import type { AgentRuntime, RuntimeRun, RuntimeRunResult, RuntimeSession } from "../agents/runtime.js";
import type { AgentRole } from "../domain/types.js";

type HarnessCase = {
  role: AgentRole;
  prompt: string;
  expectedIncludes: string;
};

const cases: HarnessCase[] = [
  { role: "agent_brief", prompt: "extract brief fields", expectedIncludes: "\"projectName\"" },
  { role: "agent_skeptic", prompt: "return feasibility verdict", expectedIncludes: "\"verdict\"" },
  { role: "agent_estimator", prompt: "estimate resources", expectedIncludes: "\"readinessScore\"" },
];

export async function runRuntimeCompatibilityHarness(runtime: AgentRuntime): Promise<void> {
  for (const testCase of cases) {
    const session = await runtime.createSession({
      cwd: process.cwd(),
      modelId: `mock-${testCase.role}`,
    });
    try {
      const run = await session.send(testCase.prompt);
      const result = await run.wait();
      assert.equal(result.status, "finished", `${testCase.role} run must finish`);
      assert.match(result.result ?? "", new RegExp(escapeRegex(testCase.expectedIncludes)));
    } finally {
      await session.dispose();
    }
  }
}

export function createMockOssRuntime(): AgentRuntime {
  return {
    async createSession(): Promise<RuntimeSession> {
      return {
        async send(prompt: string): Promise<RuntimeRun> {
          const resultText = inferMockResult(prompt);
          return createFinishedRun(resultText);
        },
        async dispose(): Promise<void> {
          // noop
        },
      };
    },
  };
}

function createFinishedRun(result: string): RuntimeRun {
  return {
    id: `run_${Date.now()}`,
    agentId: "mock-agent",
    supportsStream: false,
    async wait(): Promise<RuntimeRunResult> {
      return {
        id: `run_${Date.now()}`,
        status: "finished",
        result,
      };
    },
    async *stream(): AsyncGenerator<string, void> {
      // no stream for mock runtime
    },
  };
}

function inferMockResult(prompt: string): string {
  const lowered = prompt.toLowerCase();
  if (lowered.includes("feasibility")) {
    return JSON.stringify({ verdict: "feasible_now", action: "confirm" });
  }
  if (lowered.includes("estimate")) {
    return JSON.stringify({ readinessScore: 70, timelineWeeks: { min: 8, max: 12 } });
  }
  return JSON.stringify({ projectName: "mock-project", goal: "mock-goal" });
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
