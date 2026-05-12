export type UserProfile = "admin" | "client";
export type FoundationProvider = "anthropic" | "vllm" | "sam3";

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
