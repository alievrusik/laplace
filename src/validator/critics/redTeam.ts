import { BaseCritic, type CriticDeps } from "./base.js";
import type { CriticReport, IdeaInput } from "../types.js";
import type { TavilyClient } from "../grounding/tavily.js";

interface RedTeamDeps extends CriticDeps {
  tavily: TavilyClient;
}

export class RedTeamCritic extends BaseCritic {
  readonly role = "red_team" as const;
  protected override preferAnthropic = true;

  constructor(private readonly redTeamDeps: RedTeamDeps) {
    super(redTeamDeps);
  }

  async evaluate(_idea: IdeaInput): Promise<CriticReport> {
    return this.abstain("RedTeam запускается после базовых критиков");
  }

  async runWithPriorReports(args: { idea: IdeaInput; priorReports: CriticReport[] }): Promise<CriticReport> {
    const precedents = await this.redTeamDeps.tavily.batch([
      `${args.idea.rawPrompt} failure postmortem`,
      `${args.idea.rawPrompt} startup shutdown reasons`,
    ], 4);
    return this.completeReport(
      [
        "Ты Mandatory Dissenter (Red Team).",
        "Атакуй идею и аргументы других критиков.",
        "Сформируй blocker/warn findings c citations из precedents.",
        `precedents=${JSON.stringify(precedents.slice(0, 8))}`,
        `prior_reports=${JSON.stringify(args.priorReports.map((r) => ({ role: r.role, summary: r.summary, score: r.score })))}`,
      ].join("\n"),
      args.idea.rawPrompt,
    );
  }
}
