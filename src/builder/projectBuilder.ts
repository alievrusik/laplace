import type { ProjectBrief, BuilderResult, EvaluationVerdict } from "../domain/types.js";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  AgentRuntimeStartupError,
  CursorSdkAgentRuntime,
  type AgentRuntime,
  type RuntimeSession,
} from "../agents/runtime.js";

const MAX_EVALUATION_ATTEMPTS = 3;
const REQUIRED_EVALUATOR_TEST_MARKERS = ["FRONTEND_START", "FRONTEND_VISUAL", "FRONTEND_FLOW"] as const;
const execFileAsync = promisify(execFile);

export class ProjectBuilder {
  private readonly runtime: AgentRuntime;
  private readonly builderModelId: string;
  private readonly testerModelId: string;
  private readonly revisorModelId: string;

  constructor(
    private readonly config: {
      apiKey: string;
      model?: string;
      builderModel?: string;
      evaluatorModel?: string;
      testerModel?: string;
      revisorModel?: string;
    },
    runtime?: AgentRuntime,
  ) {
    const fallbackModel = config.model ?? "composer-2-fast";
    this.builderModelId = config.builderModel ?? fallbackModel;
    this.testerModelId = config.testerModel ?? config.evaluatorModel ?? this.builderModelId;
    this.revisorModelId = config.revisorModel ?? this.testerModelId;
    this.runtime = runtime ?? new CursorSdkAgentRuntime({ apiKey: config.apiKey });
  }

  async build(args: {
    cwd: string;
    brief: ProjectBrief;
    repoUrl: string;
    demoFoundationEnv: Record<string, string | undefined>;
    onEvent?: (message: string) => Promise<void>;
  }): Promise<BuilderResult> {
    await args.onEvent?.("Cursor Agent.create starting");
    const session = await this.withTimeout(
      this.runtime.createSession({
        cwd: args.cwd,
        modelId: this.builderModelId,
      }),
      60 * 1000,
      "Cursor Agent.create timed out after 60 seconds",
    );
    await args.onEvent?.("Cursor Agent.create finished");

    try {
      const prompt = this.renderPrompt(args);
      const evaluation = await this.buildUntilAccepted({
        cwd: args.cwd,
        brief: args.brief,
        builderSession: session,
        initialPrompt: prompt,
        timeoutMessage: "Cursor builder timed out after 10 minutes",
        onEvent: args.onEvent,
      });

      return {
        repoUrl: args.repoUrl,
        summary: `Builder finished and evaluator accepted ${args.brief.projectName}.`,
        limitations: [
          "Deploy URL is attached after deployment provider finishes the preview deployment.",
          ...evaluation.residualRisks,
        ],
        evaluation,
      };
    } catch (error) {
      if (error instanceof AgentRuntimeStartupError) {
        throw new Error(`Cursor builder startup failed: ${error.message}`);
      }
      throw error;
    } finally {
      await this.cleanupDevServers(args.cwd, args.onEvent);
      await session.dispose();
    }
  }

  async change(args: {
    cwd: string;
    projectSlug: string;
    changeRequest: string;
    onEvent?: (message: string) => Promise<void>;
  }): Promise<BuilderResult> {
    await args.onEvent?.("Cursor Agent.create starting");
    const session = await this.withTimeout(
      this.runtime.createSession({
        cwd: args.cwd,
        modelId: this.builderModelId,
      }),
      60 * 1000,
      "Cursor Agent.create timed out after 60 seconds",
    );
    await args.onEvent?.("Cursor Agent.create finished");

    try {
      const prompt = this.renderChangePrompt(args);
      const evaluation = await this.buildUntilAccepted({
        cwd: args.cwd,
        projectSlug: args.projectSlug,
        changeRequest: args.changeRequest,
        builderSession: session,
        initialPrompt: prompt,
        timeoutMessage: "Cursor change timed out after 10 minutes",
        onEvent: args.onEvent,
      });

      return {
        summary: `Change finished and evaluator accepted ${args.projectSlug}.`,
        limitations: evaluation.residualRisks,
        evaluation,
      };
    } catch (error) {
      if (error instanceof AgentRuntimeStartupError) {
        throw new Error(`Cursor change startup failed: ${error.message}`);
      }
      throw error;
    } finally {
      await this.cleanupDevServers(args.cwd, args.onEvent);
      await session.dispose();
    }
  }

  private async streamRun(
    stream: AsyncGenerator<string, void>,
    onEvent?: (message: string) => Promise<void>,
  ): Promise<void> {
    try {
      for await (const event of stream) {
        console.log(`[cursor] ${event}`);
        await onEvent?.(event);
      }
    } catch (error) {
      console.warn("Cursor stream ended with an error", error);
    }
  }

  private async buildUntilAccepted(args: {
    cwd: string;
    brief?: ProjectBrief;
    projectSlug?: string;
    changeRequest?: string;
    builderSession: RuntimeSession;
    initialPrompt: string;
    timeoutMessage: string;
    onEvent?: (message: string) => Promise<void>;
  }): Promise<EvaluationVerdict> {
    let prompt = args.initialPrompt;
    let lastVerdict: EvaluationVerdict | undefined;

    for (let attempt = 1; attempt <= MAX_EVALUATION_ATTEMPTS; attempt += 1) {
      await args.onEvent?.(`Builder attempt ${attempt}/${MAX_EVALUATION_ATTEMPTS} starting`);
      await this.runAgentMessage({
        session: args.builderSession,
        prompt,
        timeoutMessage: args.timeoutMessage,
        onEvent: args.onEvent,
      });

      await args.onEvent?.(`Tester attempt ${attempt}/${MAX_EVALUATION_ATTEMPTS} starting`);
      const testerVerdict = await this.evaluateProject({
        cwd: args.cwd,
        brief: args.brief,
        projectSlug: args.projectSlug,
        changeRequest: args.changeRequest,
        attempt,
        role: "tester",
        onEvent: args.onEvent,
      });
      await args.onEvent?.(
        `Tester verdict: ${testerVerdict.accepted ? "accepted" : "rejected"} (${testerVerdict.score}/100) - ${testerVerdict.summary}`,
      );

      if (!testerVerdict.accepted) {
        lastVerdict = testerVerdict;
      } else {
        await args.onEvent?.(`Revisor attempt ${attempt}/${MAX_EVALUATION_ATTEMPTS} starting`);
        const revisorVerdict = await this.evaluateProject({
          cwd: args.cwd,
          brief: args.brief,
          projectSlug: args.projectSlug,
          changeRequest: args.changeRequest,
          attempt,
          role: "revisor",
          testerSummary: testerVerdict.summary,
          onEvent: args.onEvent,
        });
        await args.onEvent?.(
          `Revisor verdict: ${revisorVerdict.accepted ? "accepted" : "rejected"} (${revisorVerdict.score}/100) - ${revisorVerdict.summary}`,
        );
        lastVerdict = mergeVerdicts(testerVerdict, revisorVerdict);
      }

      await args.onEvent?.(
        `Combined verdict: ${lastVerdict.accepted ? "accepted" : "rejected"} (${lastVerdict.score}/100) - ${lastVerdict.summary}`,
      );

      if (lastVerdict.accepted) return lastVerdict;
      if (attempt === MAX_EVALUATION_ATTEMPTS) break;

      prompt = this.renderFixPrompt(lastVerdict);
    }

    await args.onEvent?.("Evaluator rejected the project after maximum attempts; job will fail before commit/deploy");
    throw new Error(
      [
        "Evaluator rejected the project after maximum attempts.",
        lastVerdict ? `Summary: ${lastVerdict.summary}` : undefined,
        lastVerdict?.requiredFixes.length ? `Required fixes: ${lastVerdict.requiredFixes.join("; ")}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  private async runAgentMessage(args: {
    session: RuntimeSession;
    prompt: string;
    timeoutMessage: string;
    onEvent?: (message: string) => Promise<void>;
  }): Promise<string> {
    await args.onEvent?.("Cursor agent.send starting");
    const run = await this.withTimeout(
      args.session.send(args.prompt),
      60 * 1000,
      "Cursor agent.send timed out after 60 seconds",
    );
    await args.onEvent?.(`Cursor run started: agent=${run.agentId}, run=${run.id}`);

    const streamPromise = run.supportsStream
      ? this.streamRun(run.stream(), args.onEvent)
      : Promise.resolve();
    const result = await this.withTimeout(run.wait(), 10 * 60 * 1000, args.timeoutMessage);
    await streamPromise;

    if (result.status !== "finished") {
      throw new Error(`Cursor run did not finish successfully: ${result.id} (${result.status})`);
    }

    return result.result ?? "";
  }

  private async evaluateProject(args: {
    cwd: string;
    brief?: ProjectBrief;
    projectSlug?: string;
    changeRequest?: string;
    attempt: number;
    role: "tester" | "revisor";
    testerSummary?: string;
    onEvent?: (message: string) => Promise<void>;
  }): Promise<EvaluationVerdict> {
    const roleLabel = args.role === "tester" ? "Tester" : "Revisor";
    await args.onEvent?.(`${roleLabel} Agent.create starting`);
    const session = await this.withTimeout(
      this.runtime.createSession({
        cwd: args.cwd,
        modelId: args.role === "tester" ? this.testerModelId : this.revisorModelId,
      }),
      60 * 1000,
      `${roleLabel} Agent.create timed out after 60 seconds`,
    );
    await args.onEvent?.(`${roleLabel} Agent.create finished`);

    try {
      const output = await this.runAgentMessage({
        session,
        prompt: args.role === "tester"
          ? this.renderTesterPrompt(args)
          : this.renderRevisorPrompt(args),
        timeoutMessage: `Cursor ${args.role} timed out after 10 minutes`,
        onEvent: args.onEvent,
      });
      return parseEvaluationVerdict(output);
    } catch (error) {
      if (error instanceof AgentRuntimeStartupError) {
        throw new Error(`Cursor ${args.role} startup failed: ${error.message}`);
      }
      throw error;
    } finally {
      await this.cleanupDevServers(args.cwd, args.onEvent);
      await session.dispose();
    }
  }

  private async cleanupDevServers(cwd: string, onEvent?: (message: string) => Promise<void>): Promise<void> {
    try {
      const pids = await this.findProjectDevServerPids(cwd);
      if (!pids.length) return;

      await onEvent?.(`Cleanup: stopping ${pids.length} next dev process(es) in ${cwd}`);
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Process may already be gone.
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 800));
      for (const pid of pids) {
        try {
          process.kill(pid, 0);
          process.kill(pid, "SIGKILL");
        } catch {
          // Process is not running anymore.
        }
      }
    } catch (error) {
      await onEvent?.(`Cleanup warning: failed to stop local dev servers (${String(error)})`);
    }
  }

  private async findProjectDevServerPids(cwd: string): Promise<number[]> {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="]);
    const pids: number[] = [];

    for (const rawLine of stdout.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const firstSpace = line.indexOf(" ");
      if (firstSpace <= 0) continue;

      const pidText = line.slice(0, firstSpace).trim();
      const cmd = line.slice(firstSpace + 1);
      const pid = Number(pidText);
      if (!Number.isInteger(pid)) continue;
      if (!cmd.includes("next dev")) continue;
      if (!cmd.includes(cwd)) continue;
      pids.push(pid);
    }

    return pids;
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

  private renderPrompt(args: {
    brief: ProjectBrief;
    repoUrl: string;
    demoFoundationEnv: Record<string, string | undefined>;
  }): string {
    return `You are the Project Builder Agent for Laplace.

Build a client-facing AI/ML prototype from this structured brief:
${JSON.stringify(args.brief, null, 2)}

Repository URL:
${args.repoUrl}

Configured foundation model environment available to the generated app:
${JSON.stringify(args.demoFoundationEnv, null, 2)}

Requirements:
- Start from the existing scaffold files in the repository. Evolve and replace scaffold parts as needed instead of reinitializing the project from scratch.
- Create a small, polished prototype suitable for a cloud preview deployment.
- Build the app around the brief's input-to-output flow: user provides input, server-side API calls the configured foundation model, UI displays the output clearly.
- Choose the frontend shape that best fits the input and output. Do not force a generic layout.
- Use Russian language by default for all user-facing content: UI labels, buttons, hints, validation messages, empty states, README usage examples, and demo text unless the brief explicitly requests another language.
- Important for SAM3 segmentation quality: keep UI text Russian, but generate/normalize segmentation classes and \`text_prompt\` in English (or provide a server-side RU->EN mapping before API call).
- Keep all foundation model calls server-side. Do not expose API keys to the browser.
- Do not mention the specific model provider in product-facing UI copy.
- Document required runtime env vars generically as foundation model configuration.
- Return structured JSON from the API where possible: result fields, confidence, explanation, warnings.
- Foundation providers: do not integrate every provider just because DEMO_FOUNDATION_PROVIDERS lists several. Infer from the brief and the user's task which foundation capabilities are actually required, and implement only those—skip unused provider code paths, env wiring, and UI affordances for models that do not contribute to the solution.
- The generated app may still receive multiple providers in DEMO_FOUNDATION_PROVIDERS; use the brief and env to choose the smallest subset that solves the task.
- If DEMO_FOUNDATION_PROVIDERS includes "sam3", build a detection/segmentation flow around Segmind SAM3 Image using SAM3_API_KEY and SAM3_API_BASE_URL:
  - create a server-side API route that POSTs to \`\${SAM3_API_BASE_URL}/sam3-image\` with \`x-api-key: \${SAM3_API_KEY}\`;
  - do NOT call \`/segment\` for Segmind SAM3 Image and do NOT use \`Authorization: Bearer\` auth for this endpoint;
  - send an image URL or base64 string in \`image\`, the selected class/concept in \`text_prompt\`, and optional \`points_input\`, \`point_labels_input\`, or \`boxes_input\` as JSON strings when the UI supports refinement;
  - by default, keep segmentation UX simple: do not expose manual point/line/blob/box drawing controls unless the brief explicitly asks for interactive refinement;
  - if points/boxes/labels come from multipart form fields, parse JSON safely on server; never forward raw stringified JSON blindly;
  - request \`return_preview\`, \`return_overlay\`, or \`return_masks\` based on the UI workflow, with \`threshold\`, \`points_per_side\`, \`pred_iou_thresh\`, and \`max_masks\` as advanced server-side parameters;
  - default UI flows to visual outputs (\`return_preview\` and \`return_overlay\`) and treat mask-only responses as optional, because upstream mask formats are heterogeneous;
  - never expose SAM3_API_KEY to the browser;
  - design the UI for image upload, text prompts/classes, detection list, canvas/SVG polygon and bounding-box overlay, labels, confidence, and JSON export;
  - derive bounding boxes from polygon/mask coordinates when the user asks for detection;
  - resize or warn for images above 1024x1024 before calling the API;
  - accept image/binary responses for preview/overlay workflows and JSON-like mask responses when available; normalize heterogeneous payloads before rendering;
  - support both \`data:\` URLs and remote image URLs in normalized preview/overlay fields;
  - if SAM3 returns only one visual artifact (only preview or only overlay), mirror it to the other UI slot so "mask preview" and "overlay" panes never show a false empty state;
  - include robust fallback behavior: if remote returns 200 with empty detections/masks or remote call fails, return a useful local visual fallback with clear warning text instead of hard failure;
  - return diagnostic metadata per item (for example \`processingMode\`, \`outputKind\`, \`attemptUsed\`, \`upstreamStatus\`) to make deploy/runtime debugging possible.
- Use Segmind only for segmentation/localization flows. Do not choose Segmind LLM, image generation, video generation, audio, or embedding models for unrelated tasks.
- If DEMO_FOUNDATION_PROVIDERS also includes "anthropic" or "vllm", use them only for complementary reasoning/summarization/explanation that SAM3 does not provide directly.
- Add README.md with setup and deployment notes.
- Add prototype.md with summary, domain, task type, inputs, outputs, approach, reuse notes, links placeholders, and limitations.
- Add .cursor/rules/laplace-prototype.md describing project standards.
- Prepare the project for strict evaluator checks:
  - ensure there is a reliable local run path (\`npm run dev\` preferred; if unavailable, provide an equivalent command in README);
  - ensure build/typecheck commands exist and pass (\`npm run build\`, \`npm run typecheck\`, and lint/test when available);
  - include a short "evaluator smoke flow" section in README: exact steps to open the app, provide example input, click action, and verify expected output;
  - keep at least one deterministic happy-path scenario that can be demonstrated quickly without hidden manual setup.
- Use conservative dependencies and keep the prototype easy to inspect.
- Do not commit or push. Laplace orchestrator handles git after you finish writing files.`;
  }

  private renderChangePrompt(args: {
    projectSlug: string;
    changeRequest: string;
  }): string {
    return `You are the Project Builder Agent for Laplace.

Modify the existing project "${args.projectSlug}" in the current working directory.

Change request:
${args.changeRequest}

Rules:
- Preserve the existing project unless the change request explicitly asks for a rewrite.
- Inspect the current app before editing.
- Keep all user-facing content in Russian unless the request explicitly asks for another language.
- For SAM3 segmentation changes, keep class names/\`text_prompt\` in English (or use server-side RU->EN mapping) even when UI remains Russian.
- Keep foundation model calls server-side and do not expose secrets in browser code.
- Do not wire every foundation provider into the app by default: only add integrations that the change request (and existing project purpose) actually need.
- Keep SAM3 integration resilient: handle binary-or-JSON responses, avoid preview/overlay single-output UI breakage, and preserve/introduce empty-result + fetch-failure fallback behavior.
- Do not add manual point/line/blob/box input controls unless the change request explicitly asks for this advanced interaction.
- Keep the app deployment-ready on Render/Vercel.
- Update README.md or prototype.md if behavior or setup changes.
- Keep evaluator readiness intact: frontend must still run locally, and README must contain a reproducible smoke flow for visual/functional checks.
- Run the relevant build/typecheck/lint command when practical.
- Do not commit or push. Laplace orchestrator handles git after you finish writing files.`;
  }

  private renderTesterPrompt(args: {
    brief?: ProjectBrief;
    projectSlug?: string;
    changeRequest?: string;
    attempt: number;
  }): string {
    const target = args.brief
      ? `Original structured brief:\n${JSON.stringify(args.brief, null, 2)}`
      : `Existing project: ${args.projectSlug}\nChange request:\n${args.changeRequest}`;

    return `You are the independent Evaluator Agent for Laplace.

Your job is to inspect and test the project in the current working directory. Do not edit files.

${target}

Evaluation attempt: ${args.attempt}/${MAX_EVALUATION_ATTEMPTS}

Acceptance criteria:
- The implemented app matches the requested input-to-output flow and user-facing scenario.
- The main path is testable locally or by build/typecheck/lint commands.
- Required environment variables are documented without exposing secrets.
- Foundation model calls stay server-side; no secret is placed in client code or NEXT_PUBLIC variables.
- For segmentation/localization flows, SAM3 usage follows Segmind SAM3 Image conventions: server-side POST to /sam3-image, x-api-key auth, image plus text_prompt, optional points/boxes, and preview/overlay/mask handling. Reject if implementation uses /segment or bearer auth for this API.
- Reject if segmentation classes are sent only in Russian to SAM3 without English normalization/mapping.
- The UI is coherent, polished enough for a cloud preview, and does not mention internal provider names in client-facing copy.
- README.md, prototype.md, and .cursor/rules/laplace-prototype.md are present and useful.

Mandatory evaluator test protocol (must run on every attempt):
1) Start the frontend app locally (prefer npm run dev, fallback npm run start after build).
2) Open the running local URL and inspect the UI visually.
3) Execute at least one real user flow in the UI that matches the project goal (input -> action -> output).
4) Run code-level checks where possible (build/typecheck/lint/tests).
If any mandatory step cannot be completed, set accepted=false and explain why.

In testsRun include these exact marker prefixes so orchestration can verify coverage:
- FRONTEND_START: <command, URL, and result>
- FRONTEND_VISUAL: <what you saw in the UI>
- FRONTEND_FLOW: <user flow executed and observed output>

Run practical checks where possible, such as npm install, npm run build, npm run typecheck, npm run lint, or targeted tests. Reject if the core build/test path fails, mandatory frontend protocol is missing, the requested scenario is missing, secrets leak, or the app is clearly not usable.

Return only JSON, no markdown, matching this schema:
{
  "accepted": true,
  "score": 0,
  "summary": "short verdict",
  "issues": ["observed problems"],
  "requiredFixes": ["must-fix items before acceptance"],
  "testsRun": ["commands/checks and outcomes"],
  "residualRisks": ["non-blocking risks after acceptance"]
}`;
  }

  private renderRevisorPrompt(args: {
    brief?: ProjectBrief;
    projectSlug?: string;
    changeRequest?: string;
    attempt: number;
    testerSummary?: string;
  }): string {
    const target = args.brief
      ? `Original structured brief:\n${JSON.stringify(args.brief, null, 2)}`
      : `Existing project: ${args.projectSlug}\nChange request:\n${args.changeRequest}`;

    return `You are Revisor Agent for Laplace.

Your job is to review final UX and scenario-fit in the current working directory. Do not edit files.

${target}

Tester summary from previous stage:
${args.testerSummary ?? "not provided"}

Review attempt: ${args.attempt}/${MAX_EVALUATION_ATTEMPTS}

Acceptance criteria:
- UI flow is coherent and matches the requested business scenario.
- Smoke scenario from README can be reproduced quickly.
- User-facing copy is clear and mostly non-technical.
- For segmentation/localization tasks, visual results are understandable in UI.
- If project is update-mode, requested change is visibly reflected.

Mandatory checks:
1) Start frontend locally.
2) Open app URL and inspect visual states.
3) Execute at least one realistic user flow from input to output.
4) Confirm artifacts/docs still align with user expectation.

In testsRun include these marker prefixes:
- FRONTEND_START: <command, URL, and result>
- FRONTEND_VISUAL: <what you saw in the UI>
- FRONTEND_FLOW: <user flow executed and observed output>

Return only JSON, no markdown, matching this schema:
{
  "accepted": true,
  "score": 0,
  "summary": "short verdict",
  "issues": ["observed problems"],
  "requiredFixes": ["must-fix items before acceptance"],
  "testsRun": ["commands/checks and outcomes"],
  "residualRisks": ["non-blocking risks after acceptance"]
}`;
  }

  private renderFixPrompt(verdict: EvaluationVerdict): string {
    return `The independent evaluator rejected the current project. Fix the required issues, then stop.

Evaluator summary:
${verdict.summary}

Blocking issues:
${verdict.issues.map((issue) => `- ${issue}`).join("\n") || "- None listed"}

Required fixes:
${verdict.requiredFixes.map((fix) => `- ${fix}`).join("\n") || "- None listed"}

Tests/checks run by evaluator:
${verdict.testsRun.map((test) => `- ${test}`).join("\n") || "- None listed"}

Rules:
- Make the smallest changes needed to satisfy the evaluator.
- Keep the app deployment-ready on Render/Vercel.
- Keep foundation model calls server-side and do not expose secrets.
- Update README.md/prototype.md if the behavior or setup changes.
- Run relevant checks when practical.
- Do not commit or push.`;
  }
}

function parseEvaluationVerdict(output: string): EvaluationVerdict {
  const parsed = parseJsonObject(output);
  let accepted = parsed.accepted === true;
  const testsRun = asStringArray(parsed.testsRun);
  const missingMarkers = missingRequiredTestMarkers(testsRun);

  if (accepted && missingMarkers.length) {
    accepted = false;
  }

  const score = typeof parsed.score === "number" ? Math.max(0, Math.min(100, parsed.score)) : accepted ? 80 : 0;
  const issues = asStringArray(parsed.issues);
  const requiredFixes = asStringArray(parsed.requiredFixes);

  if (missingMarkers.length) {
    issues.push(`Evaluator verdict missing mandatory frontend test evidence: ${missingMarkers.join(", ")}`);
    requiredFixes.push(
      "Evaluator must start frontend, perform visual UI inspection, and execute at least one real user flow; include FRONTEND_START/FRONTEND_VISUAL/FRONTEND_FLOW markers in testsRun.",
    );
  }

  return {
    accepted,
    score,
    summary: asNonEmptyString(parsed.summary) ?? "Evaluator did not provide a summary.",
    issues,
    requiredFixes,
    testsRun,
    residualRisks: asStringArray(parsed.residualRisks),
  };
}

function mergeVerdicts(tester: EvaluationVerdict, revisor: EvaluationVerdict): EvaluationVerdict {
  const accepted = tester.accepted && revisor.accepted;
  const combinedScore = Math.round((tester.score + revisor.score) / 2);
  return {
    accepted,
    score: combinedScore,
    summary: accepted
      ? `Tester+Revisor accepted. Tester: ${tester.summary}; Revisor: ${revisor.summary}`
      : `Tester/Revisor rejected. Tester: ${tester.summary}; Revisor: ${revisor.summary}`,
    issues: uniqueStrings([...tester.issues, ...revisor.issues]),
    requiredFixes: uniqueStrings([...tester.requiredFixes, ...revisor.requiredFixes]),
    testsRun: uniqueStrings([...tester.testsRun, ...revisor.testsRun]),
    residualRisks: uniqueStrings([...tester.residualRisks, ...revisor.residualRisks]),
  };
}

function parseJsonObject(output: string): Record<string, unknown> {
  try {
    const value = JSON.parse(output);
    if (isRecord(value)) return value;
  } catch {
    // Fall through to extracting the first JSON object from verbose output.
  }

  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const value = JSON.parse(output.slice(start, end + 1));
    if (isRecord(value)) return value;
  }

  throw new Error(`Evaluator returned non-JSON output: ${output.slice(0, 500)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function missingRequiredTestMarkers(testsRun: string[]): string[] {
  return REQUIRED_EVALUATOR_TEST_MARKERS.filter(
    (marker) => !testsRun.some((line) => line.toUpperCase().startsWith(`${marker}:`)),
  );
}
