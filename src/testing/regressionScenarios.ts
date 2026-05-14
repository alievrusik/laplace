import assert from "node:assert/strict";
import { routePrototypeProviders } from "../orchestrator/providerRouter.js";
import { buildCapabilityTaxonomy } from "../orchestrator/capabilityTaxonomy.js";

type RegressionScenario = {
  id: string;
  archetype: "it-support" | "documents" | "vision-video" | "forecasting";
  input: string;
  expectedProviders: Array<"anthropic" | "sam3">;
};

const scenarios: RegressionScenario[] = [
  {
    id: "it-support-faq",
    archetype: "it-support",
    input: "Нужен FAQ ассистент для IT поддержки и классификации обращений",
    expectedProviders: ["anthropic"],
  },
  {
    id: "docs-procurement",
    archetype: "documents",
    input: "Нужно извлекать поля из договоров PDF и 1C документов",
    expectedProviders: ["anthropic"],
  },
  {
    id: "vision-video-segmentation",
    archetype: "vision-video",
    input: "Сегментация объектов на видео с наложением масок",
    expectedProviders: ["sam3", "anthropic"],
  },
  {
    id: "forecasting-demand",
    archetype: "forecasting",
    input: "Прогноз спроса на 12 недель для торговой сети",
    expectedProviders: ["anthropic"],
  },
];

export async function runSurveyRegressionChecks(args: {
  memoryDir: string;
  surveyPath: string;
}): Promise<void> {
  for (const scenario of scenarios) {
    const decision = routePrototypeProviders({
      message: scenario.input,
      taskType: inferTaskType(scenario.id),
      extracted: {},
      availableProviders: ["anthropic", "sam3"],
      fallbackProvider: "anthropic",
    });
    for (const provider of scenario.expectedProviders) {
      assert(decision.providers.includes(provider), `${scenario.id} must include provider ${provider}`);
    }
  }

  const taxonomy = await buildCapabilityTaxonomy({
    memoryDir: args.memoryDir,
    surveyPath: args.surveyPath,
  });
  assert(taxonomy.archetypes.length >= 4, "taxonomy should include survey archetypes");
}

function inferTaskType(id: string): "vision" | "language" | "dashboard" | "api" | "unknown" {
  if (id.includes("vision")) return "vision";
  if (id.includes("forecast")) return "dashboard";
  return "language";
}
