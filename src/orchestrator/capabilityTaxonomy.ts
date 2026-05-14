import fs from "node:fs/promises";
import path from "node:path";
import type { CapabilityArchetype, CapabilityTaxonomy, FoundationProvider } from "../domain/types.js";

const surveyArchetypes: CapabilityArchetype[] = [
  {
    id: "it-support-assistant",
    label: "IT support and FAQ copilots",
    source: "survey",
    currentlySupported: true,
    preferredProviders: ["anthropic"],
    blockingReasons: [],
    exampleSignals: ["support", "тикет", "faq", "база знаний"],
  },
  {
    id: "documents-procurement",
    label: "Document-heavy procurement and 1C workflows",
    source: "survey",
    currentlySupported: false,
    preferredProviders: ["anthropic"],
    blockingReasons: [
      "OCR/document understanding foundation model is not in current runtime stack.",
    ],
    exampleSignals: ["договор", "тендер", "закупк", "1c", "pdf"],
  },
  {
    id: "vision-video-monitoring",
    label: "Vision/video monitoring and localization",
    source: "survey",
    currentlySupported: true,
    preferredProviders: ["sam3", "anthropic"],
    blockingReasons: [],
    exampleSignals: ["камера", "видео", "детекц", "сегментац", "объект"],
  },
  {
    id: "speech-call-center",
    label: "Speech analytics and call-center transcription",
    source: "survey",
    currentlySupported: false,
    preferredProviders: ["anthropic"],
    blockingReasons: [
      "STT provider for runtime pipeline was not enabled before GigaChat integration.",
    ],
    exampleSignals: ["звонок", "аудио", "распознавание речи", "stt"],
  },
  {
    id: "forecasting-analytics",
    label: "Forecasting and planning analytics",
    source: "survey",
    currentlySupported: false,
    preferredProviders: ["anthropic"],
    blockingReasons: [
      "Dedicated forecasting model is not wired into the runtime prototype stack.",
    ],
    exampleSignals: ["прогноз", "планирование", "time series", "forecast"],
  },
];

export async function buildCapabilityTaxonomy(args: {
  memoryDir: string;
  surveyPath: string;
}): Promise<CapabilityTaxonomy> {
  const historyArchetypes = await buildHistoryArchetypes(args.memoryDir);
  const surveyExists = await fileExists(args.surveyPath);

  const archetypes = surveyExists
    ? [...surveyArchetypes, ...historyArchetypes]
    : [
        ...surveyArchetypes.map((item) => ({
          ...item,
          blockingReasons: [
            ...item.blockingReasons,
            "Survey file was not found; taxonomy uses baseline assumptions.",
          ].filter(Boolean),
        })),
        ...historyArchetypes,
      ];

  return {
    generatedAt: new Date().toISOString(),
    archetypes,
  };
}

function inferProvidersFromText(text: string): FoundationProvider[] {
  const providers: FoundationProvider[] = [];
  if (/segmentation|сегментац|detect|детекц|bbox|mask|полигон/i.test(text)) providers.push("sam3");
  if (/summary|text|текст|language|документ|faq|чаты/i.test(text)) providers.push("anthropic");
  if (!providers.length) providers.push("anthropic");
  return [...new Set(providers)];
}

async function buildHistoryArchetypes(memoryDir: string): Promise<CapabilityArchetype[]> {
  const projectsDir = path.join(memoryDir, "clients", "default-client", "projects");
  const projectNames = await listDirectories(projectsDir);
  const archetypes: CapabilityArchetype[] = [];

  for (const project of projectNames) {
    const cardPath = path.join(projectsDir, project, "project.md");
    const card = await readTextIfExists(cardPath);
    if (!card) continue;
    const summaryLine = card
      .split("\n")
      .find((line) => line.startsWith("## Summary") || line.startsWith("Summary:"));
    const text = `${project}\n${card}`.toLowerCase();

    archetypes.push({
      id: `history-${project}`,
      label: summaryLine ? summaryLine.replace(/^#+\s*/, "").trim() : `Historical pattern: ${project}`,
      source: "history",
      currentlySupported: true,
      preferredProviders: inferProvidersFromText(text),
      blockingReasons: [],
      exampleSignals: extractSignals(text),
    });
  }

  return archetypes;
}

function extractSignals(text: string): string[] {
  const dictionary = [
    "faq",
    "pdf",
    "договор",
    "segmentation",
    "сегментац",
    "forecast",
    "прогноз",
    "call",
    "звонок",
    "video",
    "камера",
  ];
  const found = dictionary.filter((token) => text.includes(token));
  return found.length ? found.slice(0, 6) : ["generic-prototype"];
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
