import type { FoundationProvider, ProjectBrief } from "../domain/types.js";

export interface ProviderRoutingDecision {
  providers: FoundationProvider[];
  rationale: string[];
}

const runtimeAllowedProviders: FoundationProvider[] = ["anthropic", "sam3"];

export function routePrototypeProviders(args: {
  message: string;
  taskType: ProjectBrief["taskType"];
  extracted: Record<string, unknown>;
  availableProviders: FoundationProvider[];
  fallbackProvider: FoundationProvider;
}): ProviderRoutingDecision {
  const availableRuntime = args.availableProviders.filter((provider) => runtimeAllowedProviders.includes(provider));
  const available: FoundationProvider[] = availableRuntime.length ? availableRuntime : ["anthropic"];
  const requested = parseFoundationProviders(args.extracted.recommendedFoundationProviders)
    .concat(parseFoundationProviders(args.extracted.recommendedFoundationProvider))
    .filter((provider) => available.includes(provider));

  const message = args.message.toLowerCase();
  const needsLocalization =
    /segmentation|сегментац|detect|detection|детекц|найти|обнаруж|bbox|bounding|маск|polygon|полигон/.test(
      message,
    );
  const needsVision =
    args.taskType === "vision" || /фото|image|изображ|спутник|satellite|снимок/.test(message);
  const needsLanguage =
    args.taskType === "language" || /текст|document|документ|pdf|отчет|summary|классиф|faq/.test(message);

  const selected: FoundationProvider[] = [];
  const rationale: string[] = [];

  if (needsLocalization && available.includes("sam3")) {
    selected.push("sam3");
    rationale.push("Detected localization/segmentation signals -> include SAM3.");
  }

  if ((needsVision || needsLanguage || !needsLocalization) && available.includes("anthropic")) {
    selected.push("anthropic");
    rationale.push("Detected language/vision reasoning needs -> include Anthropic.");
  }

  if (requested.length) {
    selected.push(...requested);
    rationale.push(`Requested providers from extracted brief: ${requested.join(", ")}.`);
  }

  if (!selected.length) {
    const fallback: FoundationProvider = available.includes(args.fallbackProvider)
      ? args.fallbackProvider
      : (available[0] ?? "anthropic");
    selected.push(fallback);
    rationale.push(`No strong routing signals; fallback to ${fallback}.`);
  }

  const providers = unique(selected).filter((provider) => runtimeAllowedProviders.includes(provider));
  if (!providers.length) {
    providers.push("anthropic");
    rationale.push("Runtime router allows only Anthropic + SAM3; forced Anthropic fallback.");
  }

  return {
    providers,
    rationale,
  };
}

export function runtimeProviderRegistry(): Array<{
  provider: FoundationProvider;
  strengths: string[];
  constraints: string[];
}> {
  return [
    {
      provider: "anthropic",
      strengths: ["reasoning", "classification", "structured extraction", "text summarization"],
      constraints: ["Not a dedicated segmentation engine; use SAM3 for precise localization."],
    },
    {
      provider: "sam3",
      strengths: ["promptable segmentation", "mask/overlay generation", "visual localization"],
      constraints: ["Use only for segmentation/localization workflows."],
    },
  ];
}

function parseFoundationProviders(value: unknown): FoundationProvider[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return values
    .map((item) => String(item).trim())
    .filter((provider): provider is FoundationProvider =>
      provider === "anthropic" || provider === "sam3" || provider === "vllm" || provider === "gigachat",
    );
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
