import { z } from "zod";

export const SeveritySchema = z.enum(["info", "warn", "blocker"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const VerdictSchema = z.enum(["go", "refine", "pivot", "reject"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const CitationSchema = z.object({
  title: z.string().min(1),
  url: z.string().url().optional(),
  snippet: z.string().optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const FindingSchema = z.object({
  severity: SeveritySchema,
  statement: z.string().min(1),
  rationale: z.string().min(1),
  citations: z.array(CitationSchema).default([]),
});
export type Finding = z.infer<typeof FindingSchema>;

export const CriticRoleSchema = z.enum([
  "tech",
  "market",
  "invest",
  "ux",
  "complexity",
  "resources",
  "team",
  "legal",
  "red_team",
]);
export type CriticRole = z.infer<typeof CriticRoleSchema>;

export const CriticReportSchema = z.object({
  role: CriticRoleSchema,
  score: z.number().min(0).max(10),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
  findings: z.array(FindingSchema).default([]),
  recommendations: z.array(z.string()).default([]),
  abstained: z.boolean().default(false),
});
export type CriticReport = z.infer<typeof CriticReportSchema>;

export const IdeaInputSchema = z.object({
  rawPrompt: z.string().min(1),
  targetMarket: z.enum(["RU"]).optional(),
  conversationContext: z.array(z.string()).default([]),
});
export type IdeaInput = z.infer<typeof IdeaInputSchema>;

export const ArbitrationReportSchema = z.object({
  contradictions: z.array(z.object({
    topic: z.string().min(1),
    conflictingClaims: z.array(z.object({
      criticRole: CriticRoleSchema,
      claim: z.string().min(1),
    })).min(2),
    resolution: z.string().min(1),
  })).default([]),
  consensusPoints: z.array(z.string()).default([]),
});
export type ArbitrationReport = z.infer<typeof ArbitrationReportSchema>;

export const FinancialModelSchema = z.object({
  tamUsd: z.object({ low: z.number().nonnegative(), mid: z.number().nonnegative(), high: z.number().nonnegative() }),
  samUsd: z.object({ low: z.number().nonnegative(), mid: z.number().nonnegative(), high: z.number().nonnegative() }),
  somUsd: z.object({ low: z.number().nonnegative(), mid: z.number().nonnegative(), high: z.number().nonnegative() }),
  unitEconomics: z.object({
    cac: z.object({ low: z.number().nonnegative(), high: z.number().nonnegative() }),
    ltv: z.object({ low: z.number().nonnegative(), high: z.number().nonnegative() }),
    paybackMonths: z.object({ low: z.number().nonnegative(), high: z.number().nonnegative() }),
    grossMarginPct: z.object({ low: z.number().min(-100).max(100), high: z.number().min(-100).max(100) }),
  }),
  burnRunway: z.object({
    monthlyBurnUsd: z.number().nonnegative(),
    runwayMonths: z.number().nonnegative(),
  }),
  assumptions: z.array(z.string()).min(5),
});
export type FinancialModel = z.infer<typeof FinancialModelSchema>;

export const RiskEntrySchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  probability: z.enum(["low", "medium", "high"]),
  impact: z.enum(["low", "medium", "high"]),
  statement: z.string().min(1),
  mitigation: z.string().min(1),
});
export type RiskEntry = z.infer<typeof RiskEntrySchema>;

export const RiskRegisterSchema = z.object({
  entries: z.array(RiskEntrySchema).default([]),
});
export type RiskRegister = z.infer<typeof RiskRegisterSchema>;

export const InvestmentMemoSchema = z.object({
  problem: z.string().min(1),
  solution: z.string().min(1),
  market: z.string().min(1),
  competition: z.string().min(1),
  team: z.string().min(1),
  traction: z.string().min(1),
  whyNow: z.string().min(1),
  financialSummary: z.string().min(1),
  topRisks: z.array(z.string()).default([]),
  recommendation: z.enum(["invest", "track", "pass"]),
  rationale: z.string().min(1),
});
export type InvestmentMemo = z.infer<typeof InvestmentMemoSchema>;

export const IdeaValidationReportSchema = z.object({
  enrichedPrompt: z.string().min(1),
  criticReports: z.array(CriticReportSchema),
  redTeamReport: CriticReportSchema.optional(),
  arbitration: ArbitrationReportSchema.optional(),
  financialModel: FinancialModelSchema.optional(),
  riskRegister: RiskRegisterSchema.optional(),
  investmentMemo: InvestmentMemoSchema.optional(),
  overallScore: z.number().min(0).max(10),
  overallConfidence: z.number().min(0).max(1),
  verdict: VerdictSchema,
});
export type IdeaValidationReport = z.infer<typeof IdeaValidationReportSchema>;

export const StaticAnalysisIssueSchema = z.object({
  filePath: z.string(),
  line: z.number().int().optional(),
  category: z.enum([
    "syntax_error",
    "import_error",
    "type_error",
    "missing_dependency",
    "todo_in_critical_path",
    "placeholder_logic",
  ]),
  message: z.string(),
});
export type StaticAnalysisIssue = z.infer<typeof StaticAnalysisIssueSchema>;

export const EmpiricalSampleCategorySchema = z.enum(["typical", "edge", "adversarial"]);
export type EmpiricalSampleCategory = z.infer<typeof EmpiricalSampleCategorySchema>;

export const EmpiricalSampleSchema = z.object({
  id: z.string(),
  payload: z.record(z.string(), z.unknown()),
  category: EmpiricalSampleCategorySchema,
  sourceSnippet: z.string().optional(),
  groundTruthHint: z.string().optional(),
  groundTruthSource: z.string().url().optional(),
});
export type EmpiricalSample = z.infer<typeof EmpiricalSampleSchema>;

export const EmpiricalRunItemSchema = z.object({
  sampleId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(["ok", "timeout", "http_error", "parse_error"]),
  latencyMs: z.number().nonnegative(),
  httpStatus: z.number().int().optional(),
  rawResponse: z.string().optional(),
  parsedResponse: z.unknown().optional(),
  schemaValid: z.boolean(),
});
export type EmpiricalRunItem = z.infer<typeof EmpiricalRunItemSchema>;

export const OracleComparisonSchema = z.object({
  sampleId: z.string(),
  agreement: z.number().min(0).max(1),
  reasoning: z.string(),
  failureCategory: z.enum([
    "wrong_output_format",
    "hallucinated_facts",
    "missed_obvious_signal",
    "incoherent",
    "irrelevant",
  ]).optional(),
  isCorrect: z.boolean().optional(),
});
export type OracleComparison = z.infer<typeof OracleComparisonSchema>;

export const EmpiricalReportSchema = z.object({
  totalSamples: z.number().int().positive(),
  coverage: z.number().min(0).max(1),
  latency: z.object({
    p50: z.number().nonnegative(),
    p95: z.number().nonnegative(),
    max: z.number().nonnegative(),
  }),
  schemaCompliance: z.number().min(0).max(1),
  agreement: z.object({
    mean: z.number().min(0).max(1),
    median: z.number().min(0).max(1),
    p25: z.number().min(0).max(1),
    p75: z.number().min(0).max(1),
  }),
  groundTruthAccuracy: z.number().min(0).max(1).optional(),
  topFailures: z.array(EmpiricalRunItemSchema).default([]),
  topSuccesses: z.array(EmpiricalRunItemSchema).default([]),
  failureBreakdown: z.record(z.string(), z.number().int().nonnegative()).default({}),
  recommendations: z.array(z.string()).default([]),
  verdict: z.enum(["production_ready", "demo_ready", "needs_iteration", "broken"]),
  approxCostUsd: z.number().nonnegative(),
  durationSec: z.number().nonnegative(),
});
export type EmpiricalReport = z.infer<typeof EmpiricalReportSchema>;

export const EmpiricalValidationResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), report: EmpiricalReportSchema }),
  z.object({ status: z.literal("failed_no_preview"), reason: z.string() }),
  z.object({ status: z.literal("failed_no_endpoint"), reason: z.string() }),
  z.object({ status: z.literal("failed_no_dataset"), reason: z.string() }),
  z.object({ status: z.literal("failed_oracle"), reason: z.string() }),
  z.object({ status: z.literal("failed_timeout"), reason: z.string() }),
  z.object({ status: z.literal("skipped"), reason: z.string() }),
]);
export type EmpiricalValidationResult = z.infer<typeof EmpiricalValidationResultSchema>;

export const PrototypeValidationReportSchema = z.object({
  matchesIntent: z.boolean(),
  intentAlignmentScore: z.number().int().min(0).max(10),
  coherenceScore: z.number().int().min(0).max(10),
  completenessScore: z.number().int().min(0).max(10),
  staticAnalysisIssues: z.array(StaticAnalysisIssueSchema).default([]),
  findings: z.array(FindingSchema).default([]),
  needsRefinement: z.boolean(),
  refinementPrompt: z.string().optional(),
  executiveSummary: z.string(),
  empiricalValidation: EmpiricalValidationResultSchema.optional(),
});
export type PrototypeValidationReport = z.infer<typeof PrototypeValidationReportSchema>;
