import fs from "node:fs/promises";
import path from "node:path";
import type { ResourceEstimate } from "../domain/types.js";
import type { LaplaceLlm } from "../llm/laplaceLlm.js";
import {
  buildHistoricalContext,
  estimateRangeFromHistoricalData,
} from "./historicalBenchmarks.js";

const USD_TO_RUB = 90;

type EstimateContext = {
  readme?: string;
  prototype?: string;
  packageJson?: string;
  memoryCard?: string;
};

export class ResourceEstimator {
  constructor(
    private readonly deps: {
      llm: LaplaceLlm;
      workspaceDir: string;
      memoryDir: string;
    },
  ) {}

  async estimateForProject(args: {
    projectSlug: string;
    conversationNotes: string[];
  }): Promise<ResourceEstimate> {
    const context = await this.readProjectContext(args.projectSlug);
    const conversation = args.conversationNotes.slice(-20).join("\n");
    const historical = buildHistoricalContext();
    const historicalBaseline = estimateRangeFromHistoricalData({
      contextText: [conversation, context.readme, context.prototype, context.memoryCard].filter(Boolean).join("\n"),
    });
    const fallback = inferFallbackEstimate(args.projectSlug, historicalBaseline, historical.sources);

    try {
      const estimate = await this.deps.llm.completeJson<ResourceEstimate>([
        {
          role: "system",
          content: renderEstimatorPrompt(),
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              projectSlug: args.projectSlug,
              conversation,
              context,
              historicalBenchmarks: {
                sources: historical.sources,
                normalizedSnapshot: historical.summary,
                baselineSuggestion: historicalBaseline,
              },
              outputRules: {
                fastRangeOnly: true,
                target: "production-readiness-estimate",
              },
            },
            null,
            2,
          ),
        },
      ]);

      return normalizeEstimate(estimate, fallback, historical.sources);
    } catch (error) {
      console.error("Resource estimation failed; using fallback", error);
      return fallback;
    }
  }

  private async readProjectContext(projectSlug: string): Promise<EstimateContext> {
    const projectPath = path.join(this.deps.workspaceDir, projectSlug);
    const memoryPath = path.join(
      this.deps.memoryDir,
      "clients",
      "default-client",
      "projects",
      projectSlug,
      "project.md",
    );

    const [readme, prototype, packageJson, memoryCard] = await Promise.all([
      readTextIfExists(path.join(projectPath, "README.md")),
      readTextIfExists(path.join(projectPath, "prototype.md")),
      readTextIfExists(path.join(projectPath, "package.json")),
      readTextIfExists(memoryPath),
    ]);

    return {
      readme: trimForPrompt(readme, 5000),
      prototype: trimForPrompt(prototype, 5000),
      packageJson: trimForPrompt(packageJson, 2000),
      memoryCard: trimForPrompt(memoryCard, 4000),
    };
  }
}

function renderEstimatorPrompt(): string {
  return `You are ResourceEstimatorAgent for Laplace.

Goal:
- Give a FAST range estimate to move a prototype to production.
- Use viewpoints of 5 team roles: CTO, Product Manager, DevOps, QA, Security.
- Return practical ranges only; do not produce exact fixed plans.
- Final response language: Russian.
- Use minimal English words in output.
- Return budget in RUB only.

Estimation constraints:
- This is pre-sales level estimation, not a final contract.
- Prefer conservative ranges where uncertainty is high.
- Include both human resources and technical resources.
- Include explicit assumptions and risks.

Output format:
Return only valid JSON with this exact shape:
{
  "projectSummary": "string",
  "readinessScore": 0,
  "timelineWeeks": { "min": 0, "max": 0 },
  "budget": { "currency": "RUB", "min": 0, "max": 0, "note": "string" },
  "humanResources": [
    {
      "role": "cto | product_manager | devops | qa | security",
      "focus": "string",
      "recommendation": "string",
      "effortWeeks": "string",
      "fteRange": "string"
    }
  ],
  "technicalResources": [
    { "area": "string", "recommendation": "string", "range": "string", "note": "string" }
  ],
  "assumptions": ["string"],
  "risks": ["string"],
  "nextSteps": ["string"]
}`;
}

function inferFallbackEstimate(
  projectSlug: string,
  baseline: ReturnType<typeof estimateRangeFromHistoricalData>,
  historicalSources: string[],
): ResourceEstimate {
  const readiness = Math.round((1 - baseline.confidencePenalty) * 100);
  const budgetMinRub = toRub(baseline.budgetUsd.min);
  const budgetMaxRub = toRub(baseline.budgetUsd.max);
  const infraMinRub = toRub(baseline.infraMonthlyUsd.min);
  const infraMaxRub = toRub(baseline.infraMonthlyUsd.max);
  return {
    projectSummary: `Быстрая диапазонная оценка для проекта ${projectSlug} с фокусом на перевод прототипа в рабочий промышленный контур.`,
    readinessScore: readiness,
    timelineWeeks: { min: baseline.timelineWeeks.min, max: baseline.timelineWeeks.max },
    budget: {
      currency: "RUB",
      min: budgetMinRub,
      max: budgetMaxRub,
      note: "Диапазон откалиброван по историческим ориентирам 2023-2025 и текущему контексту проекта.",
    },
    humanResources: [
      {
        role: "cto",
        focus: "Архитектура, технические риски, roadmap до production",
        recommendation: "Назначить технического лидера с weekly architecture checkpoints.",
        effortWeeks: "8-16",
        fteRange: "0.2-0.5 FTE",
      },
      {
        role: "product_manager",
        focus: "Требования, приоритизация, SLA и пользовательские сценарии",
        recommendation: "Закрепить PM для управления scope и приемки фич.",
        effortWeeks: "8-16",
        fteRange: "0.5-1.0 FTE",
      },
      {
        role: "devops",
        focus: "CI/CD, observability, environment hardening, release pipeline",
        recommendation: "Выделить DevOps на настройку production pipeline и мониторинга.",
        effortWeeks: "6-12",
        fteRange: "0.5-1.0 FTE",
      },
      {
        role: "qa",
        focus: "Тестовая стратегия, regression suite, release quality gates",
        recommendation: "Построить smoke + regression контур до production запуска.",
        effortWeeks: "6-14",
        fteRange: "0.5-1.0 FTE",
      },
      {
        role: "security",
        focus: "Secrets management, appsec review, threat modeling",
        recommendation: "Провести security baseline review до внешнего релиза.",
        effortWeeks: "3-8",
        fteRange: "0.2-0.5 FTE",
      },
    ],
    technicalResources: [
      {
        area: "Application",
        recommendation: "Усилить обработку ошибок, идемпотентность API и retry-политику.",
        range: "1-2 app instances",
      },
      {
        area: "Database",
        recommendation: "Добавить production БД, миграции и backup policy.",
        range: "1 managed DB cluster",
      },
      {
        area: "Observability",
        recommendation: "Включить centralized logging + metrics + alerting.",
        range: "3-6 ключевых метрик + 5-10 алертов",
      },
      {
        area: "Cloud Cost Envelope",
        recommendation: "Согласовать месячный лимит на облачную инфраструктуру до релиза и добавить контроль расходов.",
        range: `${infraMinRub}-${infraMaxRub} RUB/месяц`,
      },
      {
        area: "Security",
        recommendation: "Внедрить secrets vault + ротацию ключей + audit trail.",
        range: "1 centralized secrets setup",
      },
    ],
    assumptions: [
      "Нагрузка на старте умеренная, без массовых пиков трафика.",
      "Интеграции с внешними системами ограничены MVP-сценариями.",
      "Команда работает итерациями по 1-2 недели.",
    ],
    risks: [
      "Недооценка нефункциональных требований (SLA, latency, security).",
      "Scope creep при переходе от демо к production.",
      "Зависимость от внешних foundation providers и их лимитов.",
    ],
    nextSteps: [
      "Согласовать target SLA и expected load profile.",
      "Зафиксировать production backlog по фазам 0->1.",
      "Провести технический discovery на 1-2 недели для уточнения диапазона.",
    ],
    historicalDataNote:
      "Оценка использует нормализованный исторический срез из публичных источников (ставки специалистов, облачные цены, практики поставки и безопасности).",
    historicalSources,
  };
}

function normalizeEstimate(
  estimate: ResourceEstimate,
  fallback: ResourceEstimate,
  historicalSources: string[],
): ResourceEstimate {
  const safeReadiness = Number.isFinite(estimate.readinessScore)
    ? Math.max(0, Math.min(100, Math.round(estimate.readinessScore)))
    : fallback.readinessScore;

  return {
    projectSummary: asText(estimate.projectSummary) || fallback.projectSummary,
    readinessScore: safeReadiness,
    timelineWeeks: {
      min: clampPositiveInt(estimate.timelineWeeks?.min, fallback.timelineWeeks.min),
      max: clampPositiveInt(estimate.timelineWeeks?.max, fallback.timelineWeeks.max),
    },
    budget: normalizeBudgetToRub(estimate.budget, fallback.budget),
    humanResources: Array.isArray(estimate.humanResources) && estimate.humanResources.length
      ? estimate.humanResources.map((item) => ({
          role: normalizeRole(item.role),
          focus: asText(item.focus) || "N/A",
          recommendation: asText(item.recommendation) || "N/A",
          effortWeeks: asText(item.effortWeeks) || "N/A",
          fteRange: asText(item.fteRange) || "N/A",
        }))
      : fallback.humanResources,
    technicalResources: Array.isArray(estimate.technicalResources) && estimate.technicalResources.length
      ? estimate.technicalResources.map((item) => ({
          area: asText(item.area) || "General",
          recommendation: asText(item.recommendation) || "N/A",
          range: asText(item.range) || "N/A",
          note: asText(item.note),
        }))
      : fallback.technicalResources,
    assumptions: toStringArray(estimate.assumptions, fallback.assumptions),
    risks: toStringArray(estimate.risks, fallback.risks),
    nextSteps: toStringArray(estimate.nextSteps, fallback.nextSteps),
    historicalDataNote: asText(estimate.historicalDataNote) || fallback.historicalDataNote,
    historicalSources: toStringArray(estimate.historicalSources, fallback.historicalSources ?? historicalSources),
  };
}

function normalizeBudgetToRub(
  budget: ResourceEstimate["budget"] | undefined,
  fallback: ResourceEstimate["budget"],
): ResourceEstimate["budget"] {
  const currency = (asText(budget?.currency) || fallback.currency).toUpperCase();
  const min = clampPositiveInt(budget?.min, fallback.min);
  const max = clampPositiveInt(budget?.max, fallback.max);
  const note = asText(budget?.note) || fallback.note;

  if (currency === "USD") {
    return {
      currency: "RUB",
      min: toRub(min),
      max: toRub(max),
      note: `${note} Конвертировано в рубли по внутреннему ориентиру ${USD_TO_RUB} RUB за 1 USD.`,
    };
  }

  return {
    currency: "RUB",
    min,
    max,
    note,
  };
}

function normalizeRole(role: unknown): ResourceEstimate["humanResources"][number]["role"] {
  if (role === "cto" || role === "product_manager" || role === "devops" || role === "qa" || role === "security") {
    return role;
  }
  return "cto";
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.round(value));
}

function toRub(usd: number): number {
  return Math.round(Math.max(0, usd) * USD_TO_RUB);
}

function toStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value.map(String).map((item) => item.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

function trimForPrompt(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated]`;
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}
