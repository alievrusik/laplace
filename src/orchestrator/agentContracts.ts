import type {
  AgentRole,
  OrchestrationState,
  RuntimeModelPolicy,
  WorkflowStage,
} from "../domain/types.js";

const stageOrder: WorkflowStage[] = [
  "intake",
  "feasibility",
  "planner",
  "data_scout",
  "provider_router",
  "build",
  "test",
  "review",
  "deploy",
  "done",
];

const stageTransitions = new Map<WorkflowStage, WorkflowStage[]>([
  ["intake", ["feasibility", "estimate", "failed"]],
  ["feasibility", ["planner", "done", "failed"]],
  ["planner", ["data_scout", "provider_router", "build", "failed"]],
  ["data_scout", ["provider_router", "build", "failed"]],
  ["provider_router", ["build", "failed"]],
  ["build", ["test", "failed"]],
  ["test", ["review", "build", "failed"]],
  ["review", ["deploy", "build", "failed"]],
  ["estimate", ["done", "failed"]],
  ["deploy", ["done", "failed"]],
  ["done", []],
  ["failed", ["intake"]],
]);

export function canTransitionStage(from: WorkflowStage, to: WorkflowStage): boolean {
  return stageTransitions.get(from)?.includes(to) ?? false;
}

export function createInitialOrchestrationState(projectSlug: string): OrchestrationState {
  return {
    projectSlug,
    stage: "intake",
    canAnalyze: true,
    canConfirm: false,
    canEstimate: true,
    enoughInfo: false,
  };
}

export function applyStageTransition(state: OrchestrationState, next: WorkflowStage): OrchestrationState {
  if (!canTransitionStage(state.stage, next)) {
    throw new Error(`Invalid stage transition: ${state.stage} -> ${next}`);
  }

  return {
    ...state,
    stage: next,
    canAnalyze: next === "intake" || next === "feasibility",
    canConfirm: next === "planner" || next === "data_scout" || next === "provider_router",
    canEstimate: next !== "build" && next !== "deploy",
  };
}

export function defaultRuntimePolicy(args: {
  briefModel: string;
  skepticModel: string;
  builderModel: string;
  testerModel: string;
  revisorModel: string;
  estimatorModel: string;
}): RuntimeModelPolicy[] {
  const list: Array<{ role: AgentRole; modelId: string }> = [
    { role: "agent_brief", modelId: args.briefModel },
    { role: "agent_skeptic", modelId: args.skepticModel },
    { role: "agent_builder", modelId: args.builderModel },
    { role: "agent_tester", modelId: args.testerModel },
    { role: "agent_revisor", modelId: args.revisorModel },
    { role: "agent_estimator", modelId: args.estimatorModel },
    { role: "agent_data_scout", modelId: args.briefModel },
  ];
  return list.map((item) => ({
    role: item.role,
    modelId: item.modelId,
    reasoningEnabled: true,
  }));
}

export function sortStagesForDisplay(stages: WorkflowStage[]): WorkflowStage[] {
  const index = new Map(stageOrder.map((stage, idx) => [stage, idx]));
  return [...new Set(stages)].sort((a, b) => (index.get(a) ?? 999) - (index.get(b) ?? 999));
}
