import type { CriticReport, RiskRegister } from "./types.js";

export class RiskRegisterBuilder {
  build(args: { criticReports: CriticReport[] }): RiskRegister {
    const entries = args.criticReports
      .flatMap((report) => report.findings.map((finding, index) => ({ report, finding, index })))
      .filter(({ finding }) => finding.severity === "blocker" || finding.severity === "warn")
      .map(({ report, finding, index }) => ({
        id: `${report.role}-${index + 1}`,
        category: report.role,
        probability: finding.severity === "blocker" ? "high" as const : "medium" as const,
        impact: finding.severity === "blocker" ? "high" as const : "medium" as const,
        statement: finding.statement,
        mitigation: report.recommendations[0] ?? "Уточнить scope и ввести дополнительную проверку на этапе запуска.",
      }));
    return { entries };
  }
}
