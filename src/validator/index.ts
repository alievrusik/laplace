export { IdeaValidator } from "./orchestrator.js";
export type { IdeaValidatorConfig } from "./orchestrator.js";

export { PrototypeValidator } from "./prototypeValidator.js";
export type { PrototypeValidationInput } from "./prototypeValidator.js";

export { AnthropicClient } from "./grounding/anthropicClient.js";
export { TavilyClient } from "./grounding/tavily.js";
export { FileCache } from "./cache.js";
export { validatorPrompts, promptVersionMap } from "./prompts.js";

export {
  EmpiricalValidationResultSchema,
  FinancialModelSchema,
  IdeaInputSchema,
  IdeaValidationReportSchema,
  PrototypeValidationReportSchema,
  RiskRegisterSchema,
} from "./types.js";

export type {
  ArbitrationReport,
  Citation,
  CriticReport,
  CriticRole,
  EmpiricalReport,
  EmpiricalValidationResult,
  Finding,
  FinancialModel,
  IdeaInput,
  IdeaValidationReport,
  InvestmentMemo,
  PrototypeValidationReport,
  RiskEntry,
  RiskRegister,
  StaticAnalysisIssue,
  Verdict,
} from "./types.js";

export {
  renderEmpiricalSection,
  renderIdeaReport,
  renderPrototypeReport,
  renderQuickIdeaSummary,
} from "./render.js";
