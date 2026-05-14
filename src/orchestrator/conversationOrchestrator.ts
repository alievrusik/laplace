import type {
  CapabilityTaxonomy,
  FeasibilityAction,
  FeasibilityAssessment,
  FeasibilityVerdict,
  ProjectBrief,
  PublicDataHint,
} from "../domain/types.js";
import {
  AgentRuntimeStartupError,
  CursorSdkAgentRuntime,
  type AgentRuntime,
} from "../agents/runtime.js";
import { buildCapabilityTaxonomy } from "./capabilityTaxonomy.js";
import { PublicDataScoutAgent } from "./publicDataScout.js";
import type { LaplaceLlm } from "../llm/laplaceLlm.js";

const MAX_SOURCE_CHARS = 6000;
const AGENT_CREATE_TIMEOUT_MS = 60 * 1000;
const AGENT_SEND_TIMEOUT_MS = 60 * 1000;
const AGENT_WAIT_TIMEOUT_MS = 2 * 60 * 1000;
const MIN_FEASIBLE_CONFIDENCE = 40;

export class ConversationOrchestrator {
  private readonly runtime: AgentRuntime;
  private readonly dataScout = new PublicDataScoutAgent();

  constructor(
    private readonly deps: {
      llm: LaplaceLlm;
      cursorApiKey: string;
      runtimeCwd: string;
      briefModel: string;
      skepticModel: string;
      memoryDir?: string;
      surveyPath?: string;
    },
    runtime?: AgentRuntime,
  ) {
    this.runtime = runtime ?? new CursorSdkAgentRuntime({ apiKey: deps.cursorApiKey });
  }

  async extractBriefFields(message: string): Promise<Record<string, unknown>> {
    try {
      return await this.runAgentJson<Record<string, unknown>>({
        modelId: this.deps.briefModel,
        agentName: "agent_brief",
        systemPrompt: renderBriefExtractionPrompt(),
        userPayload: message,
        createTimeoutMessage: "Brief agent runtime startup timed out after 60 seconds",
        sendTimeoutMessage: "Brief agent send timed out after 60 seconds",
        waitTimeoutMessage: "Brief agent response timed out after 2 minutes",
      });
    } catch (runtimeError) {
      console.error("Brief agent runtime failed; fallback to LaplaceLlm", runtimeError);
    }

    try {
      return await this.deps.llm.completeJson<Record<string, unknown>>([
        {
          role: "system",
          content: renderBriefExtractionPrompt(),
        },
        {
          role: "user",
          content: message,
        },
      ]);
    } catch (error) {
      console.error("Brief extraction failed; using fallback", error);
      return {};
    }
  }

  async extractChangeRequest(source: string): Promise<string> {
    const fallback = source.trim().slice(0, 4000);
    try {
      const parsed = await this.runAgentJson<{ changeRequest?: string }>({
        modelId: this.deps.briefModel,
        agentName: "agent_brief",
        systemPrompt: renderChangeExtractionPrompt(),
        userPayload: source,
        createTimeoutMessage: "Change extraction agent runtime startup timed out after 60 seconds",
        sendTimeoutMessage: "Change extraction agent send timed out after 60 seconds",
        waitTimeoutMessage: "Change extraction agent response timed out after 2 minutes",
      });
      const changeRequest = asString(parsed.changeRequest);
      if (changeRequest) return changeRequest;
    } catch (runtimeError) {
      console.error("Change extraction agent runtime failed; fallback to LaplaceLlm", runtimeError);
    }

    try {
      const parsed = await this.deps.llm.completeJson<{ changeRequest?: string }>([
        {
          role: "system",
          content: renderChangeExtractionPrompt(),
        },
        {
          role: "user",
          content: source,
        },
      ]);
      const changeRequest = asString(parsed.changeRequest);
      if (changeRequest) return changeRequest;
    } catch (error) {
      console.error("Change request extraction failed; using raw source", error);
    }
    return fallback;
  }

  async assessFeasibility(args: {
    mode: "create" | "update";
    projectSlug: string;
    source: string;
    brief: ProjectBrief;
  }): Promise<FeasibilityAssessment> {
    const fallback = inferFallbackFeasibility(args);
    try {
      const raw = await this.runAgentJson<Partial<FeasibilityAssessment>>({
        modelId: this.deps.skepticModel,
        agentName: "agent_skeptic",
        systemPrompt: renderFeasibilityPrompt(),
        userPayload: JSON.stringify(
          {
            mode: args.mode,
            projectSlug: args.projectSlug,
            source: args.source.slice(0, MAX_SOURCE_CHARS),
            brief: args.brief,
            outputRules: {
              language: "ru",
              askAtMostOneClarifyingQuestion: true,
              mustGiveDirectVerdict: true,
            },
          },
          null,
          2,
        ),
        createTimeoutMessage: "Skeptic agent runtime startup timed out after 60 seconds",
        sendTimeoutMessage: "Skeptic agent send timed out after 60 seconds",
        waitTimeoutMessage: "Skeptic agent response timed out after 2 minutes",
      });
      return normalizeFeasibility(raw, fallback);
    } catch (error) {
      console.error("Feasibility assessment failed; using fallback", error);
      return fallback;
    }
  }

  async collectPublicDataHints(args: { brief: ProjectBrief; sourceText: string }): Promise<PublicDataHint[]> {
    return this.dataScout.collect(args);
  }

  async buildTaxonomy(): Promise<CapabilityTaxonomy> {
    return buildCapabilityTaxonomy({
      memoryDir: this.deps.memoryDir ?? pathFallback(),
      surveyPath: this.deps.surveyPath ?? "GenAI_Client_Survey_Final.xlsx",
    });
  }

  private async runAgentJson<T>(args: {
    modelId: string;
    agentName: "agent_brief" | "agent_skeptic";
    systemPrompt: string;
    userPayload: string;
    createTimeoutMessage: string;
    sendTimeoutMessage: string;
    waitTimeoutMessage: string;
  }): Promise<T> {
    const session = await this.withTimeout(
      this.runtime.createSession({
        cwd: this.deps.runtimeCwd,
        modelId: args.modelId,
      }),
      AGENT_CREATE_TIMEOUT_MS,
      args.createTimeoutMessage,
    );

    try {
      const run = await this.withTimeout(
        session.send(
          renderRuntimePrompt({
            agentName: args.agentName,
            systemPrompt: args.systemPrompt,
            userPayload: args.userPayload,
          }),
        ),
        AGENT_SEND_TIMEOUT_MS,
        args.sendTimeoutMessage,
      );
      const result = await this.withTimeout(run.wait(), AGENT_WAIT_TIMEOUT_MS, args.waitTimeoutMessage);
      if (result.status !== "finished") {
        throw new Error(`${args.agentName} run did not finish successfully: ${result.id} (${result.status})`);
      }
      return parseJsonResponse<T>(result.result ?? "");
    } catch (error) {
      if (error instanceof AgentRuntimeStartupError) {
        throw new Error(`${args.agentName} startup failed: ${error.message}`);
      }
      throw error;
    } finally {
      await session.dispose();
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function pathFallback(): string {
  return "./laplace-memory";
}

function renderBriefExtractionPrompt(): string {
  return `Extract a practical AI/ML prototype brief from a messy Russian conversation.

Important:
- Ignore casual chatter such as "как дела" unless it is part of the actual project.
- Your main job is to quickly identify the user's input data and desired output.
- Convert that into the fastest web demo where a configured foundation model transforms the input into the output.
- Prefer a foundation-model prototype when there is no dataset, no training plan, or the user wants a quick demo.
- At the current requirements-gathering stage, assume the user does not provide real files/datasets yet; describe expected input format and explicitly capture this in constraints.
- Never require client-provided input data as a hard prerequisite for MVP kickoff. If data is missing, still produce a buildable brief using placeholder/demo inputs and public/sample data for initial smoke validation.
- Foundation providers: do not recommend or assume that all available foundation models must be used. Infer which providers (sam3, anthropic, vllm, etc.) are actually needed to fulfill the user's task and list only those in recommendedFoundationProviders; omit providers that add no necessary capability.
- The prototype should be simple: upload/paste/provide input, call a server-side foundation model, show structured output.
- Do not overstate accuracy. If the user asks for "maximum accuracy" but there is no labeled dataset, frame this as calibrated prototype output with limitations.
- Pick a short English kebab-case projectName suitable for GitHub/Render services. Use semantic names, not generic words like "foundation".
- For image upload / photo analysis tasks, taskType must be "vision".
- For object localization tasks, especially satellite/aerial images, describe output as detections plus masks/polygons/overlay and prefer a visual localization API flow.
- If a task needs promptable image segmentation/detection, recommend "sam3" as Segmind SAM3 Image: server-side image URL/base64 plus text_prompt, optional points/boxes, and preview/overlay/mask outputs.
- For SAM3 integration notes in generated briefs, prefer: server-side POST SAM3_API_BASE_URL + "/sam3-image" with x-api-key auth; avoid /segment and avoid bearer auth for this API.
- Use Segmind only for segmentation/localization. Do not recommend Segmind for general LLM, image generation, video generation, audio, or embedding tasks.
- If the user asks for satellite detection or segmentation, a good projectName is "satellite-object-localization-demo".
- Return only valid JSON.

Expected JSON shape:
{
  "clientName": "Default Client",
  "projectName": "street-cleanliness-score",
  "goal": "Build a web prototype that evaluates street cleaning quality from a static uploaded photo.",
  "demoScenario": "User uploads a street photo; the app returns a 1-10 cleanliness score with explanation and visible factors.",
  "inputDescription": "Single photo of a street, sidewalk, yard, or public area.",
  "outputDescription": "Cleanliness score from 1 to 10, detected factors such as trash/dust/dirt, confidence, and explanation.",
  "foundationModelRole": "Use the configured vision foundation model to inspect the image and produce structured JSON; no custom training in MVP.",
  "taskType": "vision",
  "recommendedFoundationProviders": ["anthropic"],
  "deliverables": ["Web demo", "server-side vision API route", "README", "prototype.md"],
  "constraints": ["User does not provide real data yet at requirements-gathering stage", "No dataset is available", "Use foundation model only for MVP", "One static image at a time", "Score is not a calibrated production metric"]
}`;
}

function renderChangeExtractionPrompt(): string {
  return `You summarize a user's requested changes for an existing project.

Rules:
- Keep focus on UPDATE requests only, do not invent a new product brief.
- Keep concrete requested behavior/UI/API changes from the conversation.
- If the user provided multiple messages, merge them into one actionable change request.
- Keep language in Russian.
- Return only valid JSON.

Expected JSON:
{
  "changeRequest": "Краткий и точный запрос на изменение существующего проекта."
}`;
}

function renderFeasibilityPrompt(): string {
  return `You are SkepticAgent for Laplace.

Task:
- Evaluate if this prototype request is realistic RIGHT NOW with foundation models and no client data.
- Return one strict verdict:
  - feasible_now
  - needs_scope_reduction
  - not_feasible_now
- Keep the verdict conservative and practical.
- If not feasible, explain concrete blockers and suggest a narrower scope.
- Ask at most one clarifying question and only if it can change verdict materially.
- Output language: Russian.
- Return only valid JSON.

JSON schema:
{
  "verdict": "feasible_now | needs_scope_reduction | not_feasible_now",
  "action": "confirm | clarify | reframe",
  "confidence": 0,
  "summary": "short plain-language verdict",
  "blockers": ["blocking reasons"],
  "scopeAdjustments": ["how to make it feasible as prototype"],
  "oneClarifyingQuestion": "optional single question"
}`;
}

function renderRuntimePrompt(args: {
  agentName: "agent_brief" | "agent_skeptic";
  systemPrompt: string;
  userPayload: string;
}): string {
  return [
    `You are ${args.agentName} in Laplace.`,
    "Do not run tools and do not edit files.",
    "Return only valid JSON without markdown fences.",
    "",
    "System instructions:",
    args.systemPrompt,
    "",
    "Input:",
    args.userPayload,
  ].join("\n");
}

function parseJsonResponse<T>(text: string): T {
  return JSON.parse(extractJsonPayload(text)) as T;
}

function extractJsonPayload(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Runtime agent returned empty response");
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);

  throw new Error(`Runtime response did not contain JSON: ${trimmed.slice(0, 300)}`);
}

function inferFallbackFeasibility(args: {
  mode: "create" | "update";
  source: string;
  brief: ProjectBrief;
}): FeasibilityAssessment {
  const text = `${args.source}\n${args.brief.goal}\n${args.brief.inputDescription}\n${args.brief.outputDescription}`.toLowerCase();

  const hardSignals = /безошибоч|100%|полностью автоном|заменить сотрудников|гарантирован|идеально/i.test(text);
  if (hardSignals) {
    return {
      verdict: "needs_scope_reduction",
      action: "reframe",
      confidence: 62,
      summary: "В текущей формулировке ожидания завышены для демо на foundation моделях без клиентских данных.",
      blockers: [
        "Требуется гарантированная точность/автономность, что не подтверждается без данных и валидации.",
      ],
      scopeAdjustments: [
        "Сузить задачу до демонстрационного сценария с прозрачными ограничениями и ручной проверкой результата.",
      ],
      oneClarifyingQuestion: "Какой минимальный демонстрационный результат будет достаточным на первом этапе?",
    };
  }

  return {
    verdict: "feasible_now",
    action: "confirm",
    confidence: 55,
    summary:
      args.mode === "update"
        ? "Изменение выглядит реализуемым в текущем прототипе при аккуратном обновлении существующего потока."
        : "Сформулированный прототип выглядит реализуемым на текущем наборе foundation моделей.",
    blockers: [],
    scopeAdjustments: [],
  };
}

function normalizeFeasibility(
  raw: Partial<FeasibilityAssessment>,
  fallback: FeasibilityAssessment,
): FeasibilityAssessment {
  const verdict = normalizeVerdict(raw.verdict, fallback.verdict);
  const action = normalizeAction(raw.action, fallback.action, verdict);
  const normalizedConfidence = clampConfidence(raw.confidence, fallback.confidence);
  const confidence = verdict === "feasible_now"
    ? Math.max(MIN_FEASIBLE_CONFIDENCE, normalizedConfidence)
    : normalizedConfidence;
  const blockers = toStringArray(raw.blockers);
  const scopeAdjustments = toStringArray(raw.scopeAdjustments);

  return {
    verdict,
    action,
    confidence,
    summary: asString(raw.summary) || fallback.summary,
    blockers: blockers.length ? blockers : fallback.blockers,
    scopeAdjustments: scopeAdjustments.length ? scopeAdjustments : fallback.scopeAdjustments,
    oneClarifyingQuestion: asString(raw.oneClarifyingQuestion),
  };
}

function normalizeVerdict(
  value: unknown,
  fallback: FeasibilityVerdict,
): FeasibilityVerdict {
  if (value === "feasible_now" || value === "needs_scope_reduction" || value === "not_feasible_now") {
    return value;
  }
  return fallback;
}

function normalizeAction(
  value: unknown,
  fallback: FeasibilityAction,
  verdict: FeasibilityVerdict,
): FeasibilityAction {
  if (value === "confirm" || value === "clarify" || value === "reframe") {
    if (value === "confirm" && verdict !== "feasible_now") return "reframe";
    if ((value === "clarify" || value === "reframe") && verdict === "feasible_now") return "confirm";
    return value;
  }
  if (verdict === "feasible_now") return "confirm";
  return fallback === "confirm" ? "reframe" : fallback;
}

function clampConfidence(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
}
