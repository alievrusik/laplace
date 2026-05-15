import type { LaplaceLlm } from "../llm/laplaceLlm.js";
import { Arbitrator } from "./arbitrator.js";
import { FileCache } from "./cache.js";
import { type AnthropicLikeClient } from "./grounding/anthropicClient.js";
import { TavilyClient } from "./grounding/tavily.js";
import { InvestmentMemoBuilder } from "./investmentMemo.js";
import { FinancialModeler } from "./financialModeler.js";
import { PromptEnricher } from "./enricher.js";
import { RiskRegisterBuilder } from "./riskRegister.js";
import {
  ComplexityCritic,
  InvestCritic,
  LegalCritic,
  MarketCritic,
  RedTeamCritic,
  ResourcesCritic,
  TeamCritic,
  TechCritic,
  UxCritic,
} from "./critics/index.js";
import { type CriticReport, type IdeaInput, IdeaValidationReportSchema, type IdeaValidationReport, type Verdict } from "./types.js";

export interface IdeaValidatorConfig {
  laplaceLlm: LaplaceLlm;
  anthropic?: AnthropicLikeClient;
  tavilyApiKey?: string;
  cacheDir: string;
  cacheDisabled?: boolean;
  enableAdvanced?: boolean;
}

export class IdeaValidator {
  private readonly critics;
  private readonly redTeam: RedTeamCritic;
  private readonly arbitrator: Arbitrator;
  private readonly financialModeler: FinancialModeler;
  private readonly riskRegisterBuilder: RiskRegisterBuilder;
  private readonly investmentMemoBuilder: InvestmentMemoBuilder;
  private readonly enricher: PromptEnricher;
  private readonly enableAdvanced: boolean;

  constructor(private readonly config: IdeaValidatorConfig) {
    const cache = new FileCache(config.cacheDir, undefined, config.cacheDisabled);
    const tavily = new TavilyClient({ apiKey: config.tavilyApiKey, cache });
    const deps = { laplaceLlm: config.laplaceLlm, anthropic: config.anthropic };
    this.critics = [
      new TechCritic(deps),
      new MarketCritic({ ...deps, tavily }),
      new InvestCritic({ ...deps, tavily }),
      new UxCritic(deps),
      new ComplexityCritic(deps),
      new ResourcesCritic(deps),
      new TeamCritic(deps),
      new LegalCritic({ ...deps, tavily }),
    ];
    this.redTeam = new RedTeamCritic({ ...deps, tavily });
    this.arbitrator = new Arbitrator(deps);
    this.financialModeler = new FinancialModeler(deps);
    this.riskRegisterBuilder = new RiskRegisterBuilder();
    this.investmentMemoBuilder = new InvestmentMemoBuilder();
    this.enricher = new PromptEnricher(deps);
    this.enableAdvanced = config.enableAdvanced ?? true;
  }

  async validate(idea: IdeaInput): Promise<IdeaValidationReport> {
    const baseReports = await Promise.all(this.critics.map((critic) => critic.evaluate(idea)));
    const reports: CriticReport[] = [...baseReports];
    const redTeamReport = await this.redTeam.runWithPriorReports({ idea, priorReports: baseReports }).catch(() => undefined);
    if (redTeamReport) reports.push(redTeamReport);

    const arbitration = this.enableAdvanced ? await this.arbitrator.arbitrate(reports).catch(() => undefined) : undefined;
    const financialModel = this.enableAdvanced
      ? await this.financialModeler.build({ idea, criticReports: reports }).catch(() => undefined)
      : undefined;
    const riskRegister = this.riskRegisterBuilder.build({ criticReports: reports });
    const enrichedPrompt = await this.enricher.enrich({ idea, criticReports: reports });
    const memo = this.investmentMemoBuilder.build({
      idea: idea.rawPrompt,
      financialModel,
      riskRegister,
      topSummaries: reports.slice(0, 3).map((item) => item.summary),
    });

    const { overallScore, overallConfidence, verdict } = aggregateReports(reports);
    const result = {
      enrichedPrompt,
      criticReports: reports,
      redTeamReport,
      arbitration,
      financialModel,
      riskRegister,
      investmentMemo: memo,
      overallScore,
      overallConfidence,
      verdict,
    };
    return IdeaValidationReportSchema.parse(result);
  }

  async validateQuick(idea: IdeaInput): Promise<IdeaValidationReport> {
    const reports = await Promise.all(this.critics.map((critic) => critic.evaluate(idea)));
    const enrichedPrompt = await this.enricher.enrich({ idea, criticReports: reports });
    const { overallScore, overallConfidence, verdict } = aggregateReports(reports);
    return IdeaValidationReportSchema.parse({
      enrichedPrompt,
      criticReports: reports,
      overallScore,
      overallConfidence,
      verdict,
    });
  }
}

function aggregateReports(reports: CriticReport[]): { overallScore: number; overallConfidence: number; verdict: Verdict } {
  const usable = reports.filter((r) => !r.abstained);
  if (!usable.length) {
    return { overallScore: 5, overallConfidence: 0.2, verdict: "refine" };
  }
  const weight = usable.reduce((sum, item) => sum + item.confidence, 0);
  const weightedScore = usable.reduce((sum, item) => sum + item.score * item.confidence, 0);
  const overallScore = weight > 0 ? weightedScore / weight : 5;
  const overallConfidence = weight / usable.length;
  const abstainedCount = reports.filter((r) => r.abstained).length;
  const blockerCount = reports.flatMap((r) => r.findings).filter((f) => f.severity === "blocker").length;

  let verdict: Verdict = "refine";
  if (abstainedCount >= 5) verdict = "refine";
  else if (overallScore >= 7 && blockerCount === 0 && overallConfidence >= 0.6) verdict = "go";
  else if (overallScore < 3 || blockerCount >= 4) verdict = "reject";
  else if (overallScore < 4.5) verdict = "pivot";
  else verdict = "refine";

  return {
    overallScore: Math.round(overallScore * 100) / 100,
    overallConfidence: Math.round(overallConfidence * 100) / 100,
    verdict,
  };
}
