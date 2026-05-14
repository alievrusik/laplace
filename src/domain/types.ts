export type UserProfile = "admin" | "client";
export type FoundationProvider = "anthropic" | "vllm" | "sam3" | "gigachat";
export type FeasibilityVerdict = "feasible_now" | "needs_scope_reduction" | "not_feasible_now";
export type FeasibilityAction = "confirm" | "clarify" | "reframe";
export type AgentRole =
  | "agent_brief"
  | "agent_skeptic"
  | "agent_builder"
  | "agent_tester"
  | "agent_revisor"
  | "agent_estimator"
  | "agent_data_scout";
export type WorkflowStage =
  | "intake"
  | "feasibility"
  | "planner"
  | "data_scout"
  | "provider_router"
  | "build"
  | "test"
  | "review"
  | "estimate"
  | "deploy"
  | "done"
  | "failed";
export type WorkflowEventKind = "agent_started" | "heartbeat" | "intermediate" | "final" | "error";

export type JobStatus = "queued" | "running" | "waiting_confirmation" | "finished" | "failed";

export interface PrototypeMatch {
  slug: string;
  title: string;
  reason: string;
  reuseNotes: string;
}

export interface ProjectBrief {
  clientName: string;
  projectName: string;
  goal: string;
  demoScenario: string;
  inputDescription: string;
  outputDescription: string;
  foundationModelRole: string;
  profile: UserProfile;
  taskType: "vision" | "language" | "dashboard" | "api" | "unknown";
  recommendedFoundationProviders: FoundationProvider[];
  similarPrototypes: PrototypeMatch[];
  deliverables: string[];
  constraints: string[];
}

export interface FeasibilityAssessment {
  verdict: FeasibilityVerdict;
  action: FeasibilityAction;
  confidence: number;
  summary: string;
  blockers: string[];
  scopeAdjustments: string[];
  oneClarifyingQuestion?: string;
}

export interface RuntimeModelPolicy {
  role: AgentRole;
  modelId: string;
  reasoningEnabled: boolean;
}

export interface WorkflowEvent {
  jobId: string;
  stage: WorkflowStage;
  kind: WorkflowEventKind;
  sourceAgent?: AgentRole;
  message: string;
  isIntermediate: boolean;
  isFinal: boolean;
  createdAt: string;
}

export interface OrchestrationState {
  projectSlug: string;
  stage: WorkflowStage;
  canAnalyze: boolean;
  canConfirm: boolean;
  canEstimate: boolean;
  enoughInfo: boolean;
}

export interface CapabilityArchetype {
  id: string;
  label: string;
  source: "survey" | "history";
  currentlySupported: boolean;
  preferredProviders: FoundationProvider[];
  blockingReasons: string[];
  exampleSignals: string[];
}

export interface CapabilityTaxonomy {
  generatedAt: string;
  archetypes: CapabilityArchetype[];
}

export interface PublicDataHint {
  title: string;
  url: string;
  whyUseful: string;
}

export interface DialogProjectMapping {
  dialogId: string;
  userId: number;
  projectSlug: string;
  mode: "user" | "debug";
  createdAt: string;
  lastActivityAt: string;
}

export interface MiniAppChatMessage {
  id: string;
  dialogId: string;
  projectSlug: string;
  role: "user" | "assistant" | "system";
  text: string;
  sourceAgent?: AgentRole;
  stage?: WorkflowStage;
  isIntermediate: boolean;
  isFinal: boolean;
  createdAt: string;
}

export interface ProjectArtifactSnapshot {
  projectSlug: string;
  repoUrl?: string;
  deployUrl?: string;
  deployStatus: "unknown" | "building" | "ready" | "error";
  lastCheckedAt: string;
}

export interface SttChunkTranscript {
  chunkIndex: number;
  startedAtMs: number;
  endedAtMs: number;
  text: string;
  rawText: string;
}

export interface SttTranscriptArtifact {
  sourceAudioRef: string;
  language?: string;
  chunks: SttChunkTranscript[];
  rawTranscript: string;
  normalizedTranscript: string;
  createdAt: string;
}

export interface EmbeddingChunkVector {
  chunkIndex: number;
  text: string;
  vector: number[];
}

export interface EmbeddingArtifact {
  modelId: string;
  namespace: string;
  pooledVector: number[];
  chunks: EmbeddingChunkVector[];
  createdAt: string;
}

export interface BudgetEstimate {
  risk: "low" | "medium" | "high";
  requiresConfirmation: boolean;
  notes: string[];
}

export interface ResourcePerspectiveEstimate {
  role: "cto" | "product_manager" | "devops" | "qa" | "security";
  focus: string;
  recommendation: string;
  effortWeeks: string;
  fteRange: string;
}

export interface ResourceEstimate {
  projectSummary: string;
  readinessScore: number;
  timelineWeeks: {
    min: number;
    max: number;
  };
  budget: {
    currency: string;
    min: number;
    max: number;
    note: string;
  };
  humanResources: ResourcePerspectiveEstimate[];
  technicalResources: Array<{
    area: string;
    recommendation: string;
    range: string;
    note?: string;
  }>;
  assumptions: string[];
  risks: string[];
  nextSteps: string[];
  historicalDataNote?: string;
  historicalSources?: string[];
}

export interface BuilderResult {
  repoUrl?: string;
  previewUrl?: string;
  summary: string;
  limitations: string[];
  evaluation?: EvaluationVerdict;
}

export interface EvaluationVerdict {
  accepted: boolean;
  score: number;
  summary: string;
  issues: string[];
  requiredFixes: string[];
  testsRun: string[];
  residualRisks: string[];
}
