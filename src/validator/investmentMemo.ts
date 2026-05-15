import type { FinancialModel, InvestmentMemo, RiskRegister } from "./types.js";

export class InvestmentMemoBuilder {
  build(args: {
    idea: string;
    financialModel?: FinancialModel;
    riskRegister?: RiskRegister;
    topSummaries: string[];
  }): InvestmentMemo {
    const topRisks = (args.riskRegister?.entries ?? []).slice(0, 3).map((item) => item.statement);
    return {
      problem: `Проблема: ${args.idea.slice(0, 220)}`,
      solution: `Решение: MVP-прототип на foundation model с измеримым output.`,
      market: args.topSummaries[0] ?? "Рынок требует дополнительной валидации.",
      competition: args.topSummaries[1] ?? "Конкурентный ландшафт пока не подтвержден.",
      team: args.topSummaries[2] ?? "Профиль команды нужно уточнить.",
      traction: "Traction на текущем этапе оценивается через demo adoption и скорость итераций.",
      whyNow: "Сейчас уместно запустить быстрый prototype-run с четкими критериями проверки.",
      financialSummary: args.financialModel
        ? `TAM ${args.financialModel.tamUsd.low}-${args.financialModel.tamUsd.high} USD, runway ${args.financialModel.burnRunway.runwayMonths} мес.`
        : "Финансовая модель частичная, требуется уточнение assumptions.",
      topRisks,
      recommendation: topRisks.length >= 2 ? "track" : "invest",
      rationale: topRisks.length >= 2
        ? "Есть значимые риски; рекомендован controlled track с повторной оценкой после итерации."
        : "Риски управляемы в рамках demo-stage, можно идти в следующий этап.",
    };
  }
}
