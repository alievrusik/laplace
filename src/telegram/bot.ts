import { Markup, Telegraf } from "telegraf";
import fs from "node:fs/promises";
import path from "node:path";
import type { Context } from "telegraf";
import type { BudgetGuard } from "../budget/guard.js";
import type { ProjectBuilder } from "../builder/projectBuilder.js";
import type { AppConfig } from "../config/env.js";
import {
  VercelDeploymentError,
} from "../deploy/vercel.js";
import { RenderDeploymentError } from "../deploy/render.js";
import type { DeployInstance, DeployProject, DeployProvider } from "../deploy/provider.js";
import { slugify } from "../domain/slug.js";
import type {
  BuilderResult,
  CapabilityTaxonomy,
  EvaluationVerdict,
  FeasibilityAssessment,
  FoundationProvider,
  MiniAppChatMessage,
  ProjectBrief,
  ProjectArtifactSnapshot,
  ResourceEstimate,
  UserProfile,
} from "../domain/types.js";
import type { JobRunner } from "../jobs/runner.js";
import type { LaplaceLlm } from "../llm/laplaceLlm.js";
import type { MemoryCatalog } from "../memory/catalog.js";
import type { GitSync } from "../provision/gitSync.js";
import type { ProjectProvisioner } from "../provision/github.js";
import type { ResourceEstimator } from "../resource/estimator.js";
import type { ConversationOrchestrator } from "../orchestrator/conversationOrchestrator.js";
import { routePrototypeProviders } from "../orchestrator/providerRouter.js";
import type { DeploymentTelemetry } from "../deploy/telemetry.js";
import type { GigaChatFoundation } from "../llm/gigachat.js";
import { createTelegramAgent } from "./proxy.js";

type PendingAction = {
  projectSlug: string;
  brief: ProjectBrief;
  source: string;
  mode: "create" | "update";
};

type TelemetryMode = "user" | "debug";
type WorkflowSource = "orchestrator" | "builder" | "evaluator" | "deploy" | "estimator";
type WorkflowEventKind = "intermediate" | "milestone" | "final" | "error";

type JobFlowState = {
  ctx: Context;
  userId: number;
  currentSource: WorkflowSource;
  currentMessage: string;
  startedAt: number;
  heartbeatTimer: NodeJS.Timeout;
};

const MAX_DEPLOY_RECOVERY_ATTEMPTS = 2;
const DEPLOY_HEALTHCHECK_TIMEOUT_MS = 15000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const MINIAPP_MESSAGES_LIMIT = 300;
const MINIAPP_NOTES_LIMIT = 120;
const MEMORY_CLIENT_SLUG = "default-client";

export class TelegramBot {
  private readonly bot: Telegraf;
  private readonly profiles = new Map<number, UserProfile>();
  private readonly projectConversations = new Map<string, string[]>();
  private readonly knownProjectsByUser = new Map<number, Set<string>>();
  private readonly activeProjects = new Map<number, string>();
  private readonly pendingConfirmations = new Map<number, PendingAction>();
  private readonly pendingDeletes = new Map<number, string>();
  private readonly autoAnalyzeCheckpoint = new Map<string, number>();
  private readonly telemetryModes = new Map<number, TelemetryMode>();
  private readonly activeJobFlows = new Map<string, JobFlowState>();
  private readonly artifactSnapshots = new Map<string, ProjectArtifactSnapshot>();
  private readonly miniAppMessages = new Map<string, MiniAppChatMessage[]>();
  private readonly jobProjectIndex = new Map<string, { userId: number; projectSlug: string }>();
  private readonly loadedConversationKeys = new Set<string>();
  private readonly loadingConversationKeys = new Map<string, Promise<void>>();
  private readonly pendingConversationSaves = new Map<string, NodeJS.Timeout>();
  private capabilityTaxonomyCache:
    | { value: Awaited<ReturnType<ConversationOrchestrator["buildTaxonomy"]>>; loadedAt: number }
    | undefined;

  constructor(
    private readonly deps: {
      config: AppConfig;
      llm: LaplaceLlm;
      memory: MemoryCatalog;
      estimator: ResourceEstimator;
      orchestrator: ConversationOrchestrator;
      budget: BudgetGuard;
      jobs: JobRunner;
      provisioner: ProjectProvisioner;
      gitSync: GitSync;
      builder: ProjectBuilder;
      deploy: DeployProvider;
      deploymentTelemetry?: DeploymentTelemetry;
      gigachat?: GigaChatFoundation;
    },
  ) {
    const agent = createTelegramAgent({
      proxyUrl: deps.config.telegram.proxyUrl,
      proxyCaCertPath: deps.config.telegram.proxyCaCertPath,
    });

    this.bot = new Telegraf(deps.config.telegram.botToken, {
      telegram: agent ? { agent } : undefined,
    });
    this.bot.catch((error, ctx) => {
      console.error("Unhandled Telegram update error", error);
      void ctx.reply(
        "Лаплас столкнулся с ошибкой при обработке сообщения. Я уже записал ее в лог, можно повторить после исправления.",
      ).catch(() => undefined);
    });
    this.registerHandlers();
  }

  async launch(): Promise<void> {
    await this.deps.memory.ensureInitialized();
    console.log("Starting Laplace Telegram bot in polling mode...");
    await this.bot.launch();
  }

  stop(signal: string): void {
    for (const state of this.activeJobFlows.values()) {
      clearInterval(state.heartbeatTimer);
    }
    this.activeJobFlows.clear();
    for (const timer of this.pendingConversationSaves.values()) {
      clearTimeout(timer);
    }
    this.pendingConversationSaves.clear();
    this.bot.stop(signal);
  }

  async miniAppGetDialogState(userId: number): Promise<{
    activeProject?: string;
    projects: string[];
    mode: TelemetryMode;
  }> {
    const projects = await this.listKnownProjectsForUser(userId);
    const activeProject = this.getActiveProject(userId) ?? projects[0];
    if (activeProject && !this.getActiveProject(userId)) {
      this.activeProjects.set(userId, activeProject);
      this.addKnownProject(userId, activeProject);
    }
    return {
      activeProject,
      projects,
      mode: this.getTelemetryMode(userId),
    };
  }

  async miniAppSwitchProject(userId: number, rawProject: string): Promise<string> {
    const project = slugify(rawProject);
    if (!project) return "Некорректное имя project.";
    this.activeProjects.set(userId, project);
    this.addKnownProject(userId, project);
    await this.ensureConversationStateLoaded(userId, project);
    return `Активный project: ${project}`;
  }

  async miniAppCreateDialog(userId: number, rawProject?: string): Promise<{ dialogId: string; projectSlug: string }> {
    const suggested = rawProject?.trim()
      ? slugify(rawProject)
      : `project-${new Date().toISOString().slice(0, 16).replace(/[:t]/gi, "-")}`;
    const project = suggested || `project-${Date.now()}`;
    this.activeProjects.set(userId, project);
    this.addKnownProject(userId, project);
    await this.ensureConversationStateLoaded(userId, project);
    return {
      dialogId: this.getConversationKey(userId, project),
      projectSlug: project,
    };
  }

  async miniAppSetMode(userId: number, mode: TelemetryMode): Promise<void> {
    this.telemetryModes.set(userId, mode);
  }

  async miniAppSendMessage(args: {
    userId: number;
    projectSlug: string;
    message: string;
    profile?: UserProfile;
  }): Promise<string> {
    const projectSlug = slugify(args.projectSlug);
    const message = args.message.trim();
    if (!projectSlug) {
      throw new Error("Некорректный projectSlug");
    }
    if (!message) {
      throw new Error("Пустое сообщение");
    }
    await this.ensureConversationStateLoaded(args.userId, projectSlug);

    const profile = args.profile ?? this.profiles.get(args.userId) ?? this.deps.config.defaults.profile;
    this.addKnownProject(args.userId, projectSlug);
    this.activeProjects.set(args.userId, projectSlug);
    this.addConversationNote(args.userId, projectSlug, message);
    this.appendMiniAppMessage({
      userId: args.userId,
      projectSlug,
      role: "user",
      text: message,
      isIntermediate: false,
      isFinal: true,
    });
    const reply = await this.chatReply(args.userId, projectSlug, message, profile);
    this.appendMiniAppMessage({
      userId: args.userId,
      projectSlug,
      role: "assistant",
      text: reply,
      sourceAgent: "agent_brief",
      stage: "intake",
      isIntermediate: false,
      isFinal: true,
    });
    const ctx = this.createVirtualContext(args.userId, projectSlug);
    await this.maybeAutoAnalyze(ctx, projectSlug);
    return reply;
  }

  async miniAppAnalyze(args: {
    userId: number;
    projectSlug: string;
    inlineText?: string;
  }): Promise<boolean> {
    const projectSlug = slugify(args.projectSlug);
    if (!projectSlug) {
      throw new Error("Некорректный projectSlug");
    }
    await this.ensureConversationStateLoaded(args.userId, projectSlug);
    this.activeProjects.set(args.userId, projectSlug);
    const ctx = this.createVirtualContext(args.userId, projectSlug);
    return this.analyzeProjectContext(ctx, projectSlug, args.inlineText ?? "", false);
  }

  async miniAppConfirm(args: { userId: number }): Promise<string> {
    const action = this.pendingConfirmations.get(args.userId);
    if (!action) return "Нет задачи, ожидающей подтверждения.";
    this.pendingConfirmations.delete(args.userId);
    const ctx = this.createVirtualContext(args.userId, action.projectSlug);
    if (action.mode === "create") {
      await this.launchProjectJob(ctx, action.brief);
      return `Запущено создание project: ${action.projectSlug}`;
    }
    await this.launchChangeJob(ctx, action.projectSlug, action.source);
    return `Запущено обновление project: ${action.projectSlug}`;
  }

  async miniAppEstimate(args: { userId: number; projectSlug: string }): Promise<string> {
    const projectSlug = slugify(args.projectSlug);
    if (!projectSlug) {
      throw new Error("Некорректный projectSlug");
    }
    await this.ensureConversationStateLoaded(args.userId, projectSlug);
    this.activeProjects.set(args.userId, projectSlug);
    const notes = this.getProjectNotes(args.userId, projectSlug);
    const estimate = await this.deps.estimator.estimateForProject({
      projectSlug,
      conversationNotes: notes,
    });
    const output = formatEstimate(projectSlug, estimate);
    this.appendMiniAppMessage({
      userId: args.userId,
      projectSlug,
      role: "assistant",
      text: output,
      sourceAgent: "agent_estimator",
      stage: "estimate",
      isIntermediate: false,
      isFinal: true,
    });
    return output;
  }

  async miniAppGetMessages(args: { userId: number; projectSlug: string; limit?: number }): Promise<MiniAppChatMessage[]> {
    const projectSlug = slugify(args.projectSlug);
    if (!projectSlug) return [];
    await this.ensureConversationStateLoaded(args.userId, projectSlug);
    const key = this.getConversationKey(args.userId, projectSlug);
    const messages = this.miniAppMessages.get(key) ?? [];
    const limit = args.limit ?? 120;
    return messages.slice(-limit);
  }

  miniAppGetWorkflow(args: { projectSlug: string; limit?: number }) {
    const limit = args.limit ?? 120;
    const events = this.deps.jobs
      .list()
      .filter((job) => job.brief.projectName === args.projectSlug)
      .flatMap((job) => job.workflowEvents)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return events.slice(-limit);
  }

  async miniAppGetArtifact(projectSlug: string): Promise<ProjectArtifactSnapshot> {
    const known = this.artifactSnapshots.get(projectSlug);
    if (known) return known;

    const deployment = this.deps.deploymentTelemetry
      ? await this.deps.deploymentTelemetry.getProjectSnapshot(projectSlug)
      : await this.deps.deploy.getProjectDeploymentStatus(projectSlug);
    const projectSummary = await this.deps.memory.readProjectSummary({
      clientSlug: "default-client",
      projectSlug,
      maxChars: 4000,
    });
    const repoUrl = extractFirstUrlByLabel(projectSummary, "Repo");
    const snapshot: ProjectArtifactSnapshot = {
      projectSlug,
      repoUrl,
      deployUrl: deployment.deployUrl,
      deployStatus: deployment.state,
      lastCheckedAt: new Date().toISOString(),
    };
    this.artifactSnapshots.set(projectSlug, snapshot);
    return snapshot;
  }

  async miniAppGigaChatEmbed(args: {
    userId: number;
    projectSlug: string;
    text: string;
  }): Promise<{ vectorSize: number; chunks: number }> {
    if (!this.deps.gigachat?.isConfigured()) {
      throw new Error("GigaChat не сконфигурирован");
    }
    const artifact = await this.deps.gigachat.embedText({
      text: args.text,
      namespace: args.projectSlug,
    });
    this.appendMiniAppMessage({
      userId: args.userId,
      projectSlug: args.projectSlug,
      role: "system",
      text: `GigaChat embeddings: chunks=${artifact.chunks.length}, vectorSize=${artifact.pooledVector.length}`,
      sourceAgent: "agent_data_scout",
      stage: "data_scout",
      isIntermediate: false,
      isFinal: true,
    });
    return {
      vectorSize: artifact.pooledVector.length,
      chunks: artifact.chunks.length,
    };
  }

  async miniAppGigaChatStt(args: {
    userId: number;
    projectSlug: string;
    audioBase64: string;
    sourceAudioRef?: string;
  }): Promise<{ normalizedTranscript: string; chunks: number }> {
    if (!this.deps.gigachat?.isConfigured()) {
      throw new Error("GigaChat не сконфигурирован");
    }
    const artifact = await this.deps.gigachat.transcribeAudio({
      audio: Buffer.from(args.audioBase64, "base64"),
      sourceAudioRef: args.sourceAudioRef ?? `${args.projectSlug}:${Date.now()}`,
      language: "ru",
    });
    this.appendMiniAppMessage({
      userId: args.userId,
      projectSlug: args.projectSlug,
      role: "system",
      text: `GigaChat STT: chunks=${artifact.chunks.length}, transcript=${artifact.normalizedTranscript.slice(0, 250)}`,
      sourceAgent: "agent_data_scout",
      stage: "data_scout",
      isIntermediate: false,
      isFinal: true,
    });
    return {
      normalizedTranscript: artifact.normalizedTranscript,
      chunks: artifact.chunks.length,
    };
  }

  private registerHandlers(): void {
    this.bot.use(async (ctx, next) => {
      if (this.isAllowed(ctx.from?.id)) {
        await next();
        return;
      }

      const user = ctx.from
        ? `${ctx.from.id}${ctx.from.username ? ` (@${ctx.from.username})` : ""}`
        : "unknown user";
      console.warn(`Blocked non-whitelisted Telegram user: ${user}`);
    });

    this.bot.start(async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      await ctx.reply(renderHelp(), commandKeyboard());
    });

    this.bot.help(async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      await ctx.reply(renderHelp(), commandKeyboard());
    });

    this.bot.command("menu", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      await ctx.reply("Открыл меню команд.", commandKeyboard());
    });

    this.bot.command("miniapp", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      const url = this.deps.config.telegram.miniApp.baseUrl
        ?? `http://localhost:${this.deps.config.telegram.miniApp.port}`;
      await ctx.reply(
        `Mini App доступен по адресу: ${url}\nМожно открыть в браузере и работать с project-диалогами через кнопки analyze/confirm/estimate.`,
      );
    });

    this.bot.command("profile", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      const text = ctx.message.text;
      const nextProfile = text.includes("client") ? "client" : "admin";
      this.profiles.set(ctx.from.id, nextProfile);
      await ctx.reply(`Профиль общения переключен: ${nextProfile}.`);
    });

    this.bot.command("mode", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      const input = ctx.message.text.replace(/^\/mode(@\w+)?\s*/i, "").trim().toLowerCase();
      const current = this.getTelemetryMode(ctx.from.id);

      if (!input) {
        await ctx.reply(
          [
            `Текущий режим логов: ${current}.`,
            "Доступные режимы:",
            "- /mode user (только значимые события)",
            "- /mode debug (подробный workflow и промежуточные события)",
          ].join("\n"),
        );
        return;
      }

      const nextMode = input.includes("debug")
        ? "debug"
        : input.includes("user")
          ? "user"
          : undefined;
      if (!nextMode) {
        await ctx.reply("Не понял режим. Используй /mode user или /mode debug.");
        return;
      }

      this.telemetryModes.set(ctx.from.id, nextMode);
      await ctx.reply(
        nextMode === "debug"
          ? "Режим логов: debug. Буду показывать подробный workflow и промежуточные сообщения агентов."
          : "Режим логов: user. Буду показывать только значимые этапы и результаты.",
      );
    });

    this.bot.command("status", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      const jobs = this.deps.jobs.list().slice(0, 5);
      const lines = jobs.length
        ? jobs.map((job) => `${job.id}: ${job.status} - ${job.brief.projectName}`)
        : ["Активных задач пока нет."];
      lines.push("", renderAgentModelMap(this.deps.config.cursor));
      await ctx.reply(lines.join("\n"));
    });

    this.bot.command("models", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      await ctx.reply(renderAgentModelMap(this.deps.config.cursor));
    });

    this.bot.command("active", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      await ctx.reply(this.renderActiveProjectLine(ctx.from.id));
    });

    this.bot.command("projects", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      const projects = await this.listKnownProjectsForUser(ctx.from.id);
      const active = this.getActiveProject(ctx.from.id);
      const text = this.renderProjectList(projects, active);
      const projectButtons = projects.slice(0, 20).map((project) =>
        Markup.button.callback(`${project === active ? "● " : ""}${project}`, `project:${project}`),
      );
      await ctx.reply(
        text,
        projectButtons.length
          ? Markup.inlineKeyboard(projectButtons, { columns: 2 })
          : undefined,
      );
    });

    this.bot.command("project", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      const rawInput = ctx.message.text.replace(/^\/project(@\w+)?\s*/i, "").trim();
      if (!rawInput) {
        const active = this.getActiveProject(ctx.from.id);
        await ctx.reply(active ? `Текущий project: ${active}` : "Project не выбран. Используй /projects или /project <name>.");
        return;
      }
      if (!/[a-z0-9а-яё]/i.test(rawInput)) {
        await ctx.reply("Имя project пустое. Укажи имя после команды: /project <name>.");
        return;
      }
      const project = slugify(rawInput);
      if (/^project$/i.test(project)) {
        await ctx.reply("Чтобы создать или выбрать project, укажи имя после команды: /project <name>.");
        return;
      }

      await this.switchProjectContext(ctx, ctx.from.id, project, "command");
    });

    this.bot.command("analyze", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      const activeProject = this.getActiveProject(ctx.from.id);
      if (!activeProject) {
        await ctx.reply("Сначала выбери или создай project: /project <name>.");
        return;
      }
      const inlineText = ctx.message.text.replace(/^\/analyze(@\w+)?\s*/i, "").trim();
      await this.analyzeProjectContext(ctx, activeProject, inlineText, false);
    });

    this.bot.command("estimate", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      const activeProject = this.getActiveProject(ctx.from.id);
      if (!activeProject) {
        await ctx.reply("Сначала выбери project: /project <name>.");
        return;
      }

      const notes = this.getProjectNotes(ctx.from.id, activeProject);
      const estimateJobId = `estimate_${Date.now()}`;
      this.startJobFlow(ctx, estimateJobId, `estimate project ${activeProject}`);
      await this.emitWorkflowEvent({
        ctx,
        jobId: estimateJobId,
        source: "estimator",
        kind: "milestone",
        message: `собираю production estimate для ${activeProject}`,
      });

      try {
        const estimate = await this.deps.estimator.estimateForProject({
          projectSlug: activeProject,
          conversationNotes: notes,
        });
        await this.emitWorkflowEvent({
          ctx,
          jobId: estimateJobId,
          source: "estimator",
          kind: "final",
          message: `estimate готов для ${activeProject}: readiness=${estimate.readinessScore}/100`,
        });
        await ctx.reply(formatEstimate(activeProject, estimate));
      } catch (error) {
        await this.emitWorkflowEvent({
          ctx,
          jobId: estimateJobId,
          source: "estimator",
          kind: "error",
          message: `estimate завершился ошибкой: ${error instanceof Error ? error.message : String(error)}`,
        });
        await ctx.reply(
          `Не удалось посчитать estimate: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.stopJobFlow(estimateJobId);
      }
    });

    this.bot.command("cancel", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      this.pendingConfirmations.delete(ctx.from.id);
      this.pendingDeletes.delete(ctx.from.id);
      await ctx.reply("Ок, отменил ожидающий запуск.");
    });

    this.bot.command("delete", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      const activeProject = this.getActiveProject(ctx.from.id);
      if (!activeProject) {
        await ctx.reply("Сначала выбери project для удаления: /project <name>.");
        return;
      }

      this.pendingConfirmations.delete(ctx.from.id);
      this.pendingDeletes.set(ctx.from.id, activeProject);
      await ctx.reply(
        [
          `Подтвердить удаление project: ${activeProject}?`,
          "Будет удалено локально, в memory, GitHub и deploy-провайдере.",
          "Для подтверждения отправь /confirm, для отмены — /cancel.",
        ].join("\n"),
      );
    });

    this.bot.command("confirm", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      const pendingDelete = this.pendingDeletes.get(ctx.from.id);
      if (pendingDelete) {
        this.pendingDeletes.delete(ctx.from.id);
        const summary = await this.deleteProjectEverywhere(pendingDelete);
        this.clearDeletedProjectFromSessions(pendingDelete);
        await ctx.reply(
          [
            `Project удален: ${pendingDelete}`,
            `Локальная папка: ${summary.workspace}`,
            `Memory-карточка: ${summary.memory}`,
            `GitHub repo: ${summary.github}`,
            `Deploy service: ${summary.deploy}`,
          ].join("\n"),
        );
        return;
      }

      const action = this.pendingConfirmations.get(ctx.from.id);
      if (!action) {
        await ctx.reply("Нет задачи, ожидающей подтверждения.");
        return;
      }

      this.pendingConfirmations.delete(ctx.from.id);
      if (action.mode === "create") {
        await this.launchProjectJob(ctx, action.brief);
      } else {
        await this.launchChangeJob(ctx, action.projectSlug, action.source);
      }
    });

    this.bot.action(/^project:(.+)$/i, async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : "";
      const raw = data.replace(/^project:/i, "");
      const project = slugify(raw.trim());
      if (!project) return;
      await ctx.answerCbQuery(`Текущий project: ${project}`);
      await this.switchProjectContext(ctx, ctx.from.id, project, "button");
    });

    this.bot.on("text", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      const message = ctx.message.text.trim();
      if (message.startsWith("/")) return;

      const activeProject = this.getActiveProject(ctx.from.id);
      if (!activeProject) {
        await ctx.reply("Сначала выбери или создай project: /project <name>.");
        return;
      }

      const profile = this.profiles.get(ctx.from.id) ?? this.deps.config.defaults.profile;
      this.addConversationNote(ctx.from.id, activeProject, message);
      this.appendMiniAppMessage({
        userId: ctx.from.id,
        projectSlug: activeProject,
        role: "user",
        text: message,
        isIntermediate: false,
        isFinal: true,
      });
      const reply = await this.chatReply(ctx.from.id, activeProject, message, profile);
      this.appendMiniAppMessage({
        userId: ctx.from.id,
        projectSlug: activeProject,
        role: "assistant",
        text: reply,
        sourceAgent: "agent_brief",
        stage: "intake",
        isIntermediate: false,
        isFinal: true,
      });
      await ctx.reply(reply);
      await this.maybeAutoAnalyze(ctx, activeProject);
    });
  }

  private async listWorkspaceProjects(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.deps.config.paths.workspaceDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  private async listKnownProjectsForUser(userId: number): Promise<string[]> {
    const workspace = await this.listWorkspaceProjects();
    const memoryProjects = await this.listMemoryProjects();
    const fromDialogMemory = await this.listDialogProjectsForUser(userId);
    const known = [...(this.knownProjectsByUser.get(userId) ?? new Set<string>())];
    return [...new Set([...workspace, ...memoryProjects, ...fromDialogMemory, ...known])].sort();
  }

  private async listMemoryProjects(): Promise<string[]> {
    const projectsDir = path.join(
      this.deps.config.paths.memoryDir,
      "clients",
      MEMORY_CLIENT_SLUG,
      "projects",
    );
    try {
      const entries = await fs.readdir(projectsDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  private async listDialogProjectsForUser(userId: number): Promise<string[]> {
    const projectsDir = path.join(
      this.deps.config.paths.memoryDir,
      "clients",
      MEMORY_CLIENT_SLUG,
      "projects",
    );
    const markerName = `user-${Math.trunc(userId)}.json`;
    try {
      const entries = await fs.readdir(projectsDir, { withFileTypes: true });
      const matches = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const markerPath = path.join(projectsDir, entry.name, "dialogs", markerName);
          try {
            await fs.access(markerPath);
            return entry.name;
          } catch {
            return undefined;
          }
        }));
      return matches.filter((value): value is string => Boolean(value));
    } catch {
      return [];
    }
  }

  private addKnownProject(userId: number, project: string): void {
    const known = this.knownProjectsByUser.get(userId) ?? new Set<string>();
    known.add(project);
    this.knownProjectsByUser.set(userId, known);
  }

  private getActiveProject(userId: number): string | undefined {
    return this.activeProjects.get(userId);
  }

  private renderActiveProjectLine(userId: number): string {
    const active = this.getActiveProject(userId);
    return active ? `Текущий project: ${active}` : "Текущий project: не выбран";
  }

  private async switchProjectContext(
    ctx: Context,
    userId: number,
    project: string,
    source: "command" | "button",
  ): Promise<void> {
    this.activeProjects.set(userId, project);
    this.addKnownProject(userId, project);

    const projects = await this.listWorkspaceProjects();
    const exists = projects.includes(project);
    await ctx.reply(
      [
        exists ? `Переключился на project: ${project}.` : `Создан новый project-контекст: ${project}.`,
        exists
          ? "Теперь обсуждай изменения и запускай /analyze -> /confirm."
          : "Теперь опиши, что хочешь сделать в проекте, затем /analyze -> /confirm.",
        !exists ? "Физически репозиторий/деплой появятся после подтверждения." : undefined,
        source === "button" ? `Текущий project: ${this.getActiveProject(userId) ?? project}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      commandKeyboard(),
    );
  }

  private renderProjectList(projects: string[], active: string | undefined): string {
    if (!projects.length) {
      return [
        active ? `Текущий project: ${active}` : "Текущий project: не выбран",
        "",
        "Пока нет проектов. Создай первый командой /project <name>.",
      ].join("\n");
    }
    return [
      active ? `Текущий project: ${active}` : "Текущий project: не выбран",
      "",
      "Projects:",
      ...projects.map((project) => `${project === active ? "●" : "○"} ${project}`),
      "",
      "Переключить: кнопкой ниже или /project <name>",
      "Создать новый контекст: /project <new-name>",
    ].join("\n");
  }

  private getConversationKey(userId: number, project: string): string {
    return `${userId}:${project}`;
  }

  private getProjectNotes(userId: number, project: string): string[] {
    return this.projectConversations.get(this.getConversationKey(userId, project)) ?? [];
  }

  private addConversationNote(userId: number, project: string, message: string): void {
    const key = this.getConversationKey(userId, project);
    const notes = this.projectConversations.get(key) ?? [];
    notes.push(message);
    this.projectConversations.set(key, notes.slice(-MINIAPP_NOTES_LIMIT));
    this.addKnownProject(userId, project);
    this.scheduleConversationStateSave(userId, project);
  }

  private async analyzeProjectContext(
    ctx: Context,
    activeProject: string,
    inlineText: string,
    autoTriggered: boolean,
  ): Promise<boolean> {
    const userId = ctx.from?.id;
    if (!userId) return false;
    const notes = this.getProjectNotes(userId, activeProject);
    const source = [...notes, inlineText].filter(Boolean).join("\n");

    if (!source.trim()) {
      if (!autoTriggered) {
        await ctx.reply("Пока нечего анализировать. Опиши задачу обычными сообщениями, потом отправь /analyze.");
      }
      return false;
    }

    const projectExists = await this.projectExists(activeProject);
    const profile = this.profiles.get(userId) ?? this.deps.config.defaults.profile;
    const taxonomy = await this.getCapabilityTaxonomy();
    let brief: ProjectBrief;
    let pendingSource = source;
    let feasibility: FeasibilityAssessment;

    if (projectExists) {
      const changeRequest = await this.extractChangeRequest(source);
      pendingSource = changeRequest;
      brief = inferChangeBrief(
        activeProject,
        changeRequest,
        this.deps.config.demoFoundation.availableProviders,
      );
      const estimate = this.deps.budget.estimatePrototype(brief);
      const providers = brief.recommendedFoundationProviders.join(", ");
      feasibility = await this.deps.orchestrator.assessFeasibility({
        mode: "update",
        projectSlug: activeProject,
        source: changeRequest,
        brief,
      });

      await ctx.reply(
        [
          autoTriggered ? "Авто-analyze: контекст проекта собран, подготовил update-запрос." : undefined,
          "Режим: update existing project",
          "",
          `Проект: ${activeProject}`,
          `Change request: ${changeRequest}`,
          `Providers: ${providers}`,
          ...formatCapabilityHints(taxonomy, `${changeRequest}\n${brief.goal}`),
          formatFeasibilityLine(feasibility),
          `Feasibility confidence: ${feasibility.confidence}/100`,
          ...formatFeasibilityHints(feasibility),
          "",
          `Budget risk: ${estimate.risk}`,
          ...estimate.notes,
          "",
          feasibility.action === "confirm"
            ? "Если все ок, отправь /confirm. Если нет — уточни, что именно менять в текущем проекте, и снова /analyze."
            : "Пока /confirm заблокирован. Скорректируй scope по рекомендациям выше и снова запусти /analyze.",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } else {
      brief = await this.createBrief(source, profile);
      brief.projectName = activeProject;
      if (isGenericBrief(brief, source)) {
        if (!autoTriggered) {
          await ctx.reply(
            [
              "Пока не хватает понятной задачи для прототипа.",
              "Мне нужно уловить минимум две вещи:",
              "1. что пользователь будет загружать/вводить;",
              "2. что приложение должно вернуть/показать.",
              "",
              "Например: “загружаю фото улицы -> получаю оценку чистоты 1-10 и объяснение”.",
            ].join("\n"),
          );
        }
        return false;
      }

      const estimate = this.deps.budget.estimatePrototype(brief);
      const providers = brief.recommendedFoundationProviders.join(", ");
      const dataHints = await this.deps.orchestrator.collectPublicDataHints({
        brief,
        sourceText: source,
      });
      feasibility = await this.deps.orchestrator.assessFeasibility({
        mode: "create",
        projectSlug: activeProject,
        source,
        brief,
      });

      const similar =
        brief.similarPrototypes.length > 0
          ? brief.similarPrototypes
              .map((match) => `- ${match.title}: ${match.reason}\n  reuse: ${match.reuseNotes}`)
              .join("\n")
          : "Похожих прототипов не нашел.";

      await ctx.reply(
        [
          autoTriggered ? "Авто-analyze: контекст уже достаточно понятен, собрал задачу автоматически." : undefined,
          "Режим: create new project",
          "",
          `Проект: ${brief.projectName}`,
          `Тип: ${brief.taskType}`,
          "",
          `Задача: ${brief.goal}`,
          `Демо: ${brief.demoScenario}`,
          `Вход: ${brief.inputDescription}`,
          `Выход: ${brief.outputDescription}`,
          `Foundation model: ${brief.foundationModelRole}`,
          `Providers: ${providers}`,
          ...formatCapabilityHints(taxonomy, `${source}\n${brief.goal}\n${brief.demoScenario}`),
          ...(dataHints.length
            ? [
                "",
                "Public data hints:",
                ...dataHints.slice(0, 3).map((hint) => `- ${hint.title}: ${hint.url} (${hint.whyUseful})`),
              ]
            : []),
          formatFeasibilityLine(feasibility),
          `Feasibility confidence: ${feasibility.confidence}/100`,
          ...formatFeasibilityHints(feasibility),
          "",
          "Похожие прототипы:",
          similar,
          "",
          `Budget risk: ${estimate.risk}`,
          ...estimate.notes,
          "",
          feasibility.action === "confirm"
            ? "Если все ок, отправь /confirm. Если нет — допиши требования обычным сообщением и снова отправь /analyze."
            : "Пока /confirm заблокирован. Сузь или уточни задачу по рекомендациям и запусти /analyze снова.",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    if (feasibility.action !== "confirm") {
      this.pendingConfirmations.delete(userId);
      this.autoAnalyzeCheckpoint.set(this.getConversationKey(userId, activeProject), notes.length);
      return false;
    }

    this.pendingConfirmations.set(userId, {
      projectSlug: activeProject,
      brief,
      source: pendingSource,
      mode: projectExists ? "update" : "create",
    });
    this.autoAnalyzeCheckpoint.set(this.getConversationKey(userId, activeProject), notes.length);
    return true;
  }

  private async maybeAutoAnalyze(ctx: Context, activeProject: string): Promise<void> {
    if (!ctx.from?.id) return;
    if (this.pendingConfirmations.has(ctx.from.id) || this.pendingDeletes.has(ctx.from.id)) return;

    const notes = this.getProjectNotes(ctx.from.id, activeProject);
    if (notes.length < 3) return;

    const key = this.getConversationKey(ctx.from.id, activeProject);
    const checkpoint = this.autoAnalyzeCheckpoint.get(key) ?? 0;
    if (notes.length <= checkpoint) return;

    const joined = notes.join("\n");
    const hasInputSignal = /вход|input|загруз|ввод|текст|фото|изображ|данн|файл/i.test(joined);
    const hasOutputSignal = /выход|output|показ|верн|результ|оцен|отчет|summary|json/i.test(joined);
    if (!hasInputSignal || !hasOutputSignal) return;

    await this.analyzeProjectContext(ctx, activeProject, "", true);
  }

  private async projectExists(projectSlug: string): Promise<boolean> {
    const projects = await this.listWorkspaceProjects();
    return projects.includes(projectSlug);
  }

  private clearDeletedProjectFromSessions(projectSlug: string): void {
    for (const [userId, project] of this.activeProjects.entries()) {
      if (project === projectSlug) this.activeProjects.delete(userId);
    }
    for (const known of this.knownProjectsByUser.values()) {
      known.delete(projectSlug);
    }
    for (const key of this.projectConversations.keys()) {
      if (key.endsWith(`:${projectSlug}`)) this.projectConversations.delete(key);
    }
    for (const key of this.miniAppMessages.keys()) {
      if (key.endsWith(`:${projectSlug}`)) this.miniAppMessages.delete(key);
    }
    for (const key of this.loadedConversationKeys) {
      if (key.endsWith(`:${projectSlug}`)) this.loadedConversationKeys.delete(key);
    }
    for (const [key, pending] of this.loadingConversationKeys.entries()) {
      if (key.endsWith(`:${projectSlug}`)) this.loadingConversationKeys.delete(key);
      void pending;
    }
    for (const [key, timer] of this.pendingConversationSaves.entries()) {
      if (!key.endsWith(`:${projectSlug}`)) continue;
      clearTimeout(timer);
      this.pendingConversationSaves.delete(key);
    }
    for (const [userId, pending] of this.pendingConfirmations.entries()) {
      if (pending.projectSlug === projectSlug) this.pendingConfirmations.delete(userId);
    }
  }

  private async deleteProjectEverywhere(projectSlug: string): Promise<{
    workspace: string;
    memory: string;
    github: string;
    deploy: string;
  }> {
    const workspacePath = path.join(this.deps.config.paths.workspaceDir, projectSlug);
    const memoryPath = path.join(
      this.deps.config.paths.memoryDir,
      "clients",
      "default-client",
      "projects",
      projectSlug,
    );

    const workspace = await removeDirIfExists(workspacePath);
    const memory = await removeDirIfExists(memoryPath);
    const github = await this.deps.provisioner.deleteRepo(projectSlug).catch((error) =>
      summarizeDeleteError(error),
    );
    const deploy = await this.deps.deploy.deleteProject(projectSlug).catch((error) =>
      summarizeDeleteError(error),
    );

    return { workspace, memory, github, deploy };
  }

  private async chatReply(userId: number, project: string, message: string, profile: UserProfile): Promise<string> {
    const fallback =
      "Сейчас не получилось получить ответ от модели. Попробуй повторить через пару секунд.";
    const notes = this.getProjectNotes(userId, project);
    const recentContext = notes.slice(-8).join("\n");
    const memorySummary = await this.deps.memory.readProjectSummary({
      clientSlug: "default-client",
      projectSlug: project,
      maxChars: 5000,
    });
    const workspaceSummary = await this.readWorkspaceProjectSummary(project);
    const projectSummary = buildProjectChatSummary(memorySummary, workspaceSummary);

    try {
      const response = await this.deps.llm.complete([
        {
          role: "system",
          content: renderChatSystemPrompt(profile),
        },
        {
          role: "user",
          content: [
            `Active project: ${project}`,
            "",
            `Project memory summary:\n${projectSummary || "(no saved project summary yet)"}`,
            "",
            `Recent conversation:\n${recentContext || "(empty)"}`,
            "",
            `Latest message:\n${message}`,
          ].join("\n"),
        },
      ]);

      return sanitizeChatReply(response) || fallback;
    } catch (error) {
      console.error("Laplace chat reply failed", error);
      return fallback;
    }
  }

  private async readWorkspaceProjectSummary(projectSlug: string): Promise<string | undefined> {
    const projectDir = path.join(this.deps.config.paths.workspaceDir, projectSlug);
    const [readme, prototypeDoc, packageJsonRaw, rootEntries] = await Promise.all([
      this.readFileIfExists(path.join(projectDir, "README.md")),
      this.readFileIfExists(path.join(projectDir, "prototype.md")),
      this.readFileIfExists(path.join(projectDir, "package.json")),
      fs.readdir(projectDir).catch(() => [] as string[]),
    ]);

    const sections: string[] = [];
    if (rootEntries.length) {
      sections.push(`Project root entries: ${rootEntries.slice(0, 25).join(", ")}`);
    }

    if (packageJsonRaw) {
      try {
        const parsed = JSON.parse(packageJsonRaw) as {
          name?: string;
          scripts?: Record<string, string>;
          dependencies?: Record<string, string>;
        };
        sections.push(
          [
            `package.name: ${parsed.name ?? projectSlug}`,
            `scripts: ${Object.keys(parsed.scripts ?? {}).join(", ") || "none"}`,
            `dependencies: ${Object.keys(parsed.dependencies ?? {}).slice(0, 20).join(", ") || "none"}`,
          ].join("\n"),
        );
      } catch {
        sections.push("package.json: present but failed to parse");
      }
    }

    if (prototypeDoc?.trim()) {
      sections.push(`prototype.md:\n${truncateText(prototypeDoc, 2200)}`);
    }
    if (readme?.trim()) {
      sections.push(`README.md:\n${truncateText(readme, 2200)}`);
    }

    if (!sections.length) return undefined;
    return sections.join("\n\n");
  }

  private async readFileIfExists(targetPath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(targetPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async launchProjectJob(
    ctx: Context,
    brief: ProjectBrief,
  ): Promise<void> {
    const job = this.deps.jobs.create(brief);
    await ctx.reply(`Запускаю builder job: ${job.id}`);
    this.startJobFlow(ctx, job.id, `create project ${brief.projectName}`);
    if (ctx.from?.id) {
      this.jobProjectIndex.set(job.id, { userId: ctx.from.id, projectSlug: brief.projectName });
    }

    void this.deps.jobs.run(job.id, async () => {
      await this.notifyStage(ctx, job.id, "создаю GitHub repository и локальную папку");
      const provisioned = await this.deps.provisioner.provision(brief.projectName);

      await this.notifyStage(ctx, job.id, "запускаю Cursor SDK builder");
      const builderResult = await this.deps.builder.build({
        cwd: provisioned.localPath,
        brief,
        repoUrl: provisioned.repoUrl,
        onEvent: (message) => this.forwardBuilderEvent(ctx, job.id, message),
        demoFoundationEnv: await this.createDemoFoundationEnv(brief, "sanitized"),
      });

      await this.notifyStage(ctx, job.id, "коммичу и пушу код в GitHub");
      await this.deps.gitSync.push({
        cwd: provisioned.localPath,
        remoteUrl: provisioned.pushUrl,
        message: `Create ${brief.projectName} prototype`,
        authorName: provisioned.gitAuthorName,
        authorEmail: provisioned.gitAuthorEmail,
      });

      const deployResult = await this.runDeployPipelineWithSelfHealing({
        ctx,
        jobId: job.id,
        projectSlug: provisioned.slug,
        repoId: provisioned.repoId,
        repoFullName: provisioned.fullName,
        envVars: await this.createDemoFoundationEnv(brief, "secrets"),
        workspacePath: provisioned.localPath,
        remoteUrl: provisioned.pushUrl,
        gitAuthorName: provisioned.gitAuthorName,
        gitAuthorEmail: provisioned.gitAuthorEmail,
        fixContext: [
          `Это первичная сборка нового проекта ${provisioned.slug}.`,
          `Оригинальная цель: ${brief.goal}`,
          `Сценарий демо: ${brief.demoScenario}`,
        ].join("\n"),
      });

      const result = {
        ...builderResult,
        previewUrl: deployResult.deployment.url ?? deployResult.project.url,
      };
      this.updateArtifactSnapshot(provisioned.slug, {
        repoUrl: provisioned.repoUrl,
        deployUrl: result.previewUrl,
        deployStatus: "ready",
      });

      await this.notifyStage(ctx, job.id, "сохраняю карточку проекта в memory");
      await this.deps.memory.writeProjectCard({
        clientSlug: "default-client",
        projectSlug: provisioned.slug,
        markdown: renderProjectCard(brief, result),
      });
      await this.deps.memory.appendProjectHistory({
        clientSlug: "default-client",
        projectSlug: provisioned.slug,
        entryMarkdown: renderProjectHistoryEntry({
          type: "create",
          projectSlug: provisioned.slug,
          summary: result.summary,
          repoUrl: result.repoUrl,
          previewUrl: result.previewUrl,
          evaluation: result.evaluation,
          notes: result.limitations,
        }),
      });

      await this.emitWorkflowEvent({
        ctx,
        jobId: job.id,
        source: "orchestrator",
        kind: "final",
        message: `workflow завершен: проект ${brief.projectName} собран и задеплоен`,
      });
      await ctx.reply(formatResult(brief.profile, result.repoUrl, result.previewUrl, result.evaluation));
      return result;
    }).then(async (finalJob) => {
      if (finalJob.status === "failed") {
        await this.emitWorkflowEvent({
          ctx,
          jobId: job.id,
          source: "orchestrator",
          kind: "error",
          message: finalJob.error
            ? `workflow завершился ошибкой: ${finalJob.error}`
            : "workflow завершился ошибкой без текста причины",
        });
        await ctx.reply(
          [
            `Задача завершилась с ошибкой: ${finalJob.id}`,
            finalJob.error ? `Причина: ${finalJob.error}` : undefined,
            "Можно уточнить требования или попробовать снова.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
    }).catch(async (error) => {
      await this.emitWorkflowEvent({
        ctx,
        jobId: job.id,
        source: "orchestrator",
        kind: "error",
        message: `не удалось получить итоговый статус job: ${error instanceof Error ? error.message : String(error)}`,
      });
      await ctx.reply(
        `Не удалось получить итоговый статус задачи ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }).finally(() => {
      this.stopJobFlow(job.id);
      this.jobProjectIndex.delete(job.id);
    });
  }

  private async launchChangeJob(ctx: Context, projectSlug: string, changeRequest: string): Promise<void> {
    const repo = await this.deps.provisioner.resolveExisting(projectSlug);
    const brief = inferChangeBrief(projectSlug, changeRequest, this.deps.config.demoFoundation.availableProviders);
    const job = this.deps.jobs.create(brief);
    await ctx.reply(`Запускаю change job: ${job.id}`);
    this.startJobFlow(ctx, job.id, `update project ${projectSlug}`);
    if (ctx.from?.id) {
      this.jobProjectIndex.set(job.id, { userId: ctx.from.id, projectSlug });
    }

    void this.deps.jobs.run(job.id, async () => {
      await this.notifyStage(ctx, job.id, `изменяю существующий проект ${projectSlug}`);
      const builderResult = await this.deps.builder.change({
        cwd: repo.localPath,
        projectSlug,
        changeRequest,
        onEvent: (message) => this.forwardBuilderEvent(ctx, job.id, message),
      });

      await this.notifyStage(ctx, job.id, "коммичу и пушу изменения");
      await this.deps.gitSync.push({
        cwd: repo.localPath,
        remoteUrl: repo.pushUrl,
        message: `Update ${projectSlug}: ${changeRequest.slice(0, 80)}`,
        authorName: repo.gitAuthorName,
        authorEmail: repo.gitAuthorEmail,
      });

      await this.notifyStage(ctx, job.id, "запускаю redeploy");
      const deployResult = await this.runDeployPipelineWithSelfHealing({
        ctx,
        jobId: job.id,
        projectSlug,
        repoId: repo.repoId,
        repoFullName: repo.fullName,
        envVars: await this.createDemoFoundationEnv(brief, "secrets"),
        workspacePath: repo.localPath,
        remoteUrl: repo.pushUrl,
        gitAuthorName: repo.gitAuthorName,
        gitAuthorEmail: repo.gitAuthorEmail,
        fixContext: [
          `Это изменение существующего проекта ${projectSlug}.`,
          `Изначальный change request: ${changeRequest}`,
        ].join("\n"),
      });

      const cardPath = await this.deps.memory.writeProjectCard({
        clientSlug: "default-client",
        projectSlug,
        markdown: renderChangeCard(projectSlug, changeRequest, builderResult, repo.repoUrl, deployResult.deployment.url),
      });
      await this.deps.memory.appendProjectHistory({
        clientSlug: "default-client",
        projectSlug,
        entryMarkdown: renderProjectHistoryEntry({
          type: "update",
          projectSlug,
          changeRequest,
          summary: builderResult.summary,
          repoUrl: repo.repoUrl,
          previewUrl: deployResult.deployment.url,
          evaluation: builderResult.evaluation,
          notes: builderResult.limitations,
        }),
      });
      console.log(`Updated memory card: ${cardPath}`);
      this.updateArtifactSnapshot(projectSlug, {
        repoUrl: repo.repoUrl,
        deployUrl: deployResult.deployment.url,
        deployStatus: "ready",
      });

      await this.emitWorkflowEvent({
        ctx,
        jobId: job.id,
        source: "orchestrator",
        kind: "final",
        message: `workflow завершен: изменения для ${projectSlug} задеплоены`,
      });
      await ctx.reply(
        [
          `Готово, изменения отправлены.`,
          builderResult.evaluation
            ? `Evaluator: accepted (${builderResult.evaluation.score}/100)`
            : undefined,
          `Repo: ${repo.repoUrl}`,
          `Deploy: ${deployResult.deployment.url}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );

      return {
        ...builderResult,
        repoUrl: repo.repoUrl,
        previewUrl: deployResult.deployment.url,
      };
    }).then(async (finalJob) => {
      if (finalJob.status === "failed") {
        await this.emitWorkflowEvent({
          ctx,
          jobId: job.id,
          source: "orchestrator",
          kind: "error",
          message: finalJob.error
            ? `workflow завершился ошибкой: ${finalJob.error}`
            : "workflow завершился ошибкой без текста причины",
        });
        await ctx.reply(
          [
            `Задача завершилась с ошибкой: ${finalJob.id}`,
            finalJob.error ? `Причина: ${finalJob.error}` : undefined,
            "Можно поправить запрос и запустить заново.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
    }).catch(async (error) => {
      await this.emitWorkflowEvent({
        ctx,
        jobId: job.id,
        source: "orchestrator",
        kind: "error",
        message: `не удалось получить итоговый статус job: ${error instanceof Error ? error.message : String(error)}`,
      });
      await ctx.reply(
        `Не удалось получить итоговый статус задачи ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }).finally(() => {
      this.stopJobFlow(job.id);
      this.jobProjectIndex.delete(job.id);
    });
  }

  private async forwardBuilderEvent(ctx: Context, jobId: string, message: string): Promise<void> {
    if (!this.shouldForwardBuilderEvent(message)) return;
    await this.emitWorkflowEvent({
      ctx,
      jobId,
      source: this.inferSourceFromBuilderEvent(message),
      kind: this.inferKindFromBuilderEvent(message),
      message,
    });
  }

  private shouldForwardBuilderEvent(message: string): boolean {
    return (
      message.startsWith("Cursor Agent") ||
      message.startsWith("Cursor agent") ||
      message.startsWith("Cursor run started") ||
      message.startsWith("Cursor status") ||
      message.startsWith("Cursor tool") ||
      message.startsWith("Cursor task") ||
      message.startsWith("Cursor:") ||
      message.startsWith("Builder attempt") ||
      message.startsWith("Evaluator")
    );
  }

  private inferSourceFromBuilderEvent(message: string): WorkflowSource {
    return message.startsWith("Evaluator") ? "evaluator" : "builder";
  }

  private inferKindFromBuilderEvent(message: string): WorkflowEventKind {
    if (/rejected|failed|error/i.test(message)) return "error";
    if (/verdict/i.test(message)) return "final";
    if (/attempt|starting|run started/i.test(message)) return "milestone";
    return "intermediate";
  }

  private async runDeployPipelineWithSelfHealing(args: {
    ctx: Context;
    jobId: string;
    projectSlug: string;
    repoId: number;
    repoFullName: string;
    envVars: Record<string, string | undefined>;
    workspacePath: string;
    remoteUrl: string;
    gitAuthorName: string;
    gitAuthorEmail: string;
    fixContext: string;
  }): Promise<{ project: DeployProject; deployment: DeployInstance }> {
    let finalProject: DeployProject | undefined;
    let finalDeployment: DeployInstance | undefined;
    const provider = this.deps.deploy.platform;

    for (let attempt = 1; attempt <= MAX_DEPLOY_RECOVERY_ATTEMPTS + 1; attempt += 1) {
      let stage = "create_project";
      await this.notifyStage(
        args.ctx,
        args.jobId,
        `запускаю ${provider} pipeline (attempt ${attempt}/${MAX_DEPLOY_RECOVERY_ATTEMPTS + 1})`,
      );
      try {
        await this.notifyStage(args.ctx, args.jobId, `создаю/обновляю ${provider} project ${args.projectSlug}`);
        finalProject = await this.deps.deploy.createProject(args.projectSlug, {
          type: "github",
          repo: args.repoFullName,
        });

        stage = "disable_protection";
        await this.notifyStage(args.ctx, args.jobId, `выполняю pre-deploy setup (${provider})`);
        await this.deps.deploy.disableDeploymentProtection(finalProject.id);

        stage = "set_env";
        await this.notifyStage(args.ctx, args.jobId, `синхронизирую ${provider} environment variables`);
        await this.deps.deploy.setEnvironmentVariables(args.projectSlug, args.envVars);

        stage = "create_deploy";
        await this.notifyStage(args.ctx, args.jobId, `запускаю ${provider} deployment`);
        const startedDeployment = await this.deps.deploy.createDeployment({
          projectName: args.projectSlug,
          gitSource: {
            type: "github",
            repoId: args.repoId,
            repo: args.repoFullName,
            ref: "main",
          },
        });
        stage = "wait_build";
        await this.notifyStage(args.ctx, args.jobId, `жду завершения ${provider} build`);
        finalDeployment = await this.deps.deploy.waitForDeployment(startedDeployment.id);
        if (!finalDeployment.url && finalProject.url) {
          finalDeployment = { ...finalDeployment, url: finalProject.url };
        }

        stage = "healthcheck";
        await this.notifyStage(args.ctx, args.jobId, "выполняю healthcheck на задеплоенном проекте");
        await this.healthcheckDeployment(finalDeployment.url);

        stage = "cleanup";
        await this.notifyStage(args.ctx, args.jobId, `очищаю старые ${provider} deployment`);
        const cleaned = await this.deps.deploy.cleanupOldDeployments({
          projectId: finalProject.id,
          keepDeploymentIds: [finalDeployment.id],
        });
        if (cleaned.deleted || cleaned.failed) {
          await this.notifyStage(
            args.ctx,
            args.jobId,
            `${provider} cleanup: удалено ${cleaned.deleted}, ошибок ${cleaned.failed}`,
          );
        }
        break;
      } catch (error) {
        const errorSummary = summarizeDeleteError(error);
        await this.notifyStage(
          args.ctx,
          args.jobId,
          `${provider} pipeline failed (attempt ${attempt}/${MAX_DEPLOY_RECOVERY_ATTEMPTS + 1}): ${errorSummary}`,
        );
        if (attempt > MAX_DEPLOY_RECOVERY_ATTEMPTS) throw error;

        await this.notifyStage(
          args.ctx,
          args.jobId,
          `передаю ошибку deploy (${stage}) билдеру для авто-фикса (${attempt}/${MAX_DEPLOY_RECOVERY_ATTEMPTS})`,
        );
        const fixRequest = this.renderDeployFixRequest({
          fixContext: args.fixContext,
          stage,
          error,
        });
        await this.deps.builder.change({
          cwd: args.workspacePath,
          projectSlug: args.projectSlug,
          changeRequest: fixRequest,
          onEvent: (message) => this.forwardBuilderEvent(args.ctx, args.jobId, message),
        });

        await this.notifyStage(args.ctx, args.jobId, "пушу авто-фикс в GitHub перед повторным деплоем");
        await this.deps.gitSync.push({
          cwd: args.workspacePath,
          remoteUrl: args.remoteUrl,
          message: `Fix ${args.projectSlug}: recover from ${provider} deploy failure #${attempt}`,
          authorName: args.gitAuthorName,
          authorEmail: args.gitAuthorEmail,
        });
      }
    }

    if (!finalProject || !finalDeployment) {
      throw new Error("Deploy pipeline recovery finished without a deployment result");
    }

    return { project: finalProject, deployment: finalDeployment };
  }

  private renderDeployFixRequest(args: { fixContext: string; stage: string; error: unknown }): string {
    const failure = this.describeDeployError(args.error);
    const provider = this.deps.deploy.platform;
    return [
      `${provider} pipeline failed after pushing current code to main.`,
      args.fixContext,
      "",
      `Failed stage: ${args.stage}`,
      "",
      "Observed deploy error:",
      failure,
      "",
      "What to do:",
      "- Identify and fix the root cause for this deploy stage failure.",
      "- If env vars/config are inconsistent, align project code and runtime configuration so env sync and deploy both succeed.",
      "- Run local checks that map to deploy expectations (at minimum npm run build and npm run typecheck when available).",
      "- Ensure deployed app responds successfully after build (basic healthcheck on / should return non-error).",
      "- Update config/docs only if needed for successful deployment.",
      "- Keep fixes minimal, safe, and production-ready.",
    ].join("\n");
  }

  private describeDeployError(error: unknown): string {
    if (error instanceof VercelDeploymentError || error instanceof RenderDeploymentError) {
      return [
        `State: ${error.state}`,
        `Message: ${error.message}`,
        error.deploymentUrl ? `Deployment URL: ${error.deploymentUrl}` : undefined,
        error.inspectorUrl ? `Inspector URL: ${error.inspectorUrl}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    }

    if (error instanceof Error) return error.message;
    return String(error);
  }

  private async healthcheckDeployment(url: string): Promise<void> {
    if (!url) {
      throw new Error("Deployment URL is missing after build");
    }
    const target = normalizeHealthcheckUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEPLOY_HEALTHCHECK_TIMEOUT_MS);
    const provider = this.deps.deploy.platform;
    let response: Response;
    try {
      response = await fetch(target, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(
        `${provider} healthcheck failed for ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 500) {
      throw new Error(`${provider} healthcheck returned ${response.status} for ${target}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = (await response.text()).trim();
    if (!body) {
      throw new Error(`${provider} healthcheck returned empty body for ${target}`);
    }

    if (contentType && !/text\/html|application\/json|text\/plain/i.test(contentType)) {
      throw new Error(`${provider} healthcheck returned unexpected content-type "${contentType}" for ${target}`);
    }
  }

  private async notifyStage(ctx: Context, jobId: string, message: string): Promise<void> {
    const line = `[${jobId}] ${message}`;
    console.log(line);
    await this.emitWorkflowEvent({
      ctx,
      jobId,
      source: this.inferSourceFromStageMessage(message),
      kind: this.inferKindFromStageMessage(message),
      message,
    });
  }

  private getTelemetryMode(userId: number | undefined): TelemetryMode {
    if (!userId) return "user";
    return this.telemetryModes.get(userId) ?? "user";
  }

  private startJobFlow(ctx: Context, jobId: string, initialMessage: string): void {
    const userId = ctx.from?.id;
    if (!userId) return;

    this.stopJobFlow(jobId);
    const heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat(jobId);
    }, HEARTBEAT_INTERVAL_MS);

    this.activeJobFlows.set(jobId, {
      ctx,
      userId,
      currentSource: "orchestrator",
      currentMessage: initialMessage,
      startedAt: Date.now(),
      heartbeatTimer,
    });

    void this.emitWorkflowEvent({
      ctx,
      jobId,
      source: "orchestrator",
      kind: "milestone",
      message: `workflow started: ${initialMessage}`,
    }).catch((error) => {
      console.warn(`Failed to emit workflow start for ${jobId}`, error);
    });
  }

  private stopJobFlow(jobId: string): void {
    const state = this.activeJobFlows.get(jobId);
    if (!state) return;
    clearInterval(state.heartbeatTimer);
    this.activeJobFlows.delete(jobId);
  }

  private async sendHeartbeat(jobId: string): Promise<void> {
    const state = this.activeJobFlows.get(jobId);
    if (!state) return;

    const elapsedMinutes = Math.max(1, Math.floor((Date.now() - state.startedAt) / 60_000));
    const source = workflowSourceLabel(state.currentSource);
    const line = `[${jobId}] heartbeat (${elapsedMinutes}m): ${source} -> ${compactWorkflowText(state.currentMessage)}`;
    try {
      await state.ctx.reply(line);
    } catch (error) {
      console.warn(`Failed to send heartbeat for ${jobId}`, error);
    }
  }

  private async emitWorkflowEvent(args: {
    ctx: Context;
    jobId: string;
    source: WorkflowSource;
    kind: WorkflowEventKind;
    message: string;
  }): Promise<void> {
    const stage = workflowSourceToStage(args.source);
    const state = this.activeJobFlows.get(args.jobId);
    const indexed = this.jobProjectIndex.get(args.jobId);
    this.deps.jobs.updateStage(args.jobId, stage);
    this.deps.jobs.pushWorkflowEvent(args.jobId, {
      jobId: args.jobId,
      stage,
      kind: mapWorkflowEventKind(args.kind),
      sourceAgent: workflowSourceToAgent(args.source),
      message: args.message,
      isIntermediate: args.kind === "intermediate" || args.kind === "milestone",
      isFinal: args.kind === "final" || args.kind === "error",
      createdAt: new Date().toISOString(),
    });
    if (state) {
      state.currentSource = args.source;
      state.currentMessage = args.message;
    }

    const mode = this.getTelemetryMode(state?.userId ?? args.ctx.from?.id);
    if (!this.shouldEmitEvent(mode, args.kind)) return;

    const source = workflowSourceLabel(args.source);
    const severity = args.kind === "error" ? "ERROR " : "";
    const line = `[${args.jobId}] ${severity}${source}: ${args.message}`;
    await args.ctx.reply(line);

    if (indexed) {
      this.appendMiniAppMessage({
        userId: indexed.userId,
        projectSlug: indexed.projectSlug,
        role: "system",
        text: line,
        sourceAgent: workflowSourceToAgent(args.source),
        stage,
        isIntermediate: args.kind === "intermediate" || args.kind === "milestone",
        isFinal: args.kind === "final" || args.kind === "error",
      });

      if (args.source === "deploy") {
        const deployStatus = args.kind === "error"
          ? "error"
          : /ready|готов|healthcheck/i.test(args.message)
            ? "ready"
            : "building";
        this.updateArtifactSnapshot(indexed.projectSlug, { deployStatus });
      }
    }
  }

  private shouldEmitEvent(mode: TelemetryMode, kind: WorkflowEventKind): boolean {
    if (mode === "debug") return true;
    return kind !== "intermediate";
  }

  private inferSourceFromStageMessage(message: string): WorkflowSource {
    const lowered = message.toLowerCase();
    if (lowered.includes("deploy") || lowered.includes("healthcheck") || lowered.includes("render")) {
      return "deploy";
    }
    if (lowered.includes("evaluator")) return "evaluator";
    if (lowered.includes("builder")) return "builder";
    if (lowered.includes("estimate")) return "estimator";
    return "orchestrator";
  }

  private inferKindFromStageMessage(message: string): WorkflowEventKind {
    if (/failed|error|ошиб/i.test(message)) return "error";
    if (/готово|заверш|accepted|finished/i.test(message)) return "final";
    return "milestone";
  }

  private async resolveAnthropicProxyCaBase64(): Promise<string | undefined> {
    if (this.deps.config.demoFoundation.anthropicProxyCaCertBase64) {
      return this.deps.config.demoFoundation.anthropicProxyCaCertBase64;
    }

    const certPath = this.deps.config.demoFoundation.anthropicProxyCaCertPath;
    if (!certPath) return undefined;

    const buffer = await fs.readFile(certPath);
    return buffer.toString("base64");
  }

  private async createDemoFoundationEnv(
    brief: ProjectBrief,
    mode: "sanitized" | "secrets",
  ): Promise<Record<string, string | undefined>> {
    const selected = brief.recommendedFoundationProviders;
    const primaryProvider = selected[0] ?? this.deps.config.demoFoundation.provider;
    const has = (provider: FoundationProvider) => selected.includes(provider);
    const configured = (value: string | undefined) => (value ? "configured" : undefined);

    return {
      DEMO_FOUNDATION_PROVIDER: primaryProvider,
      DEMO_FOUNDATION_PROVIDERS: selected.join(","),
      AVAILABLE_FOUNDATION_PROVIDERS: this.deps.config.demoFoundation.availableProviders.join(","),
      ...(has("anthropic")
        ? {
            ANTHROPIC_API_KEY:
              mode === "sanitized"
                ? configured(this.deps.config.demoFoundation.anthropicApiKey)
                : this.deps.config.demoFoundation.anthropicApiKey,
            ANTHROPIC_MODEL: this.deps.config.demoFoundation.anthropicModel,
            ANTHROPIC_PROXY_URL:
              mode === "sanitized"
                ? configured(this.deps.config.demoFoundation.anthropicProxyUrl)
                : this.deps.config.demoFoundation.deployUseAnthropicProxy
                  ? this.deps.config.demoFoundation.anthropicProxyUrl
                  : undefined,
            ANTHROPIC_PROXY_CA_CERT_BASE64:
              mode === "sanitized"
                ? configured(
                    this.deps.config.demoFoundation.anthropicProxyCaCertBase64 ||
                      this.deps.config.demoFoundation.anthropicProxyCaCertPath,
                  )
                : this.deps.config.demoFoundation.deployUseAnthropicProxy
                  ? await this.resolveAnthropicProxyCaBase64()
                  : undefined,
          }
        : {}),
      ...(has("vllm")
        ? {
            DEMO_VLLM_BASE_URL: this.deps.config.demoFoundation.vllmBaseURL,
            DEMO_VLLM_API_KEY:
              mode === "sanitized"
                ? configured(this.deps.config.demoFoundation.vllmApiKey)
                : this.deps.config.demoFoundation.vllmApiKey,
            DEMO_VLLM_MODEL: this.deps.config.demoFoundation.vllmModel,
          }
        : {}),
      ...(has("sam3")
        ? {
            SAM3_API_KEY:
              mode === "sanitized"
                ? configured(this.deps.config.demoFoundation.sam3ApiKey)
                : this.deps.config.demoFoundation.sam3ApiKey,
            SAM3_API_BASE_URL: this.deps.config.demoFoundation.sam3ApiBaseURL,
          }
        : {}),
      ...(has("gigachat")
        ? {
            GIGACHAT_BASE_URL: this.deps.config.demoFoundation.gigachat.baseURL,
            GIGACHAT_AUTH_URL: this.deps.config.demoFoundation.gigachat.authURL,
            GIGACHAT_SCOPE: this.deps.config.demoFoundation.gigachat.scope,
            GIGACHAT_MODEL: this.deps.config.demoFoundation.gigachat.model,
            GIGACHAT_EMBEDDINGS_MODEL: this.deps.config.demoFoundation.gigachat.embeddingsModel,
            GIGACHAT_STT_MODEL: this.deps.config.demoFoundation.gigachat.sttModel,
            GIGACHAT_VERIFY_SSL_CERTS: String(this.deps.config.demoFoundation.gigachat.verifySslCerts),
            GIGACHAT_CLIENT_ID:
              mode === "sanitized"
                ? configured(this.deps.config.demoFoundation.gigachat.clientId)
                : this.deps.config.demoFoundation.gigachat.clientId,
            GIGACHAT_CLIENT_SECRET:
              mode === "sanitized"
                ? configured(this.deps.config.demoFoundation.gigachat.clientSecret)
                : this.deps.config.demoFoundation.gigachat.clientSecret,
            GIGACHAT_ACCESS_TOKEN:
              mode === "sanitized"
                ? configured(this.deps.config.demoFoundation.gigachat.accessToken)
                : this.deps.config.demoFoundation.gigachat.accessToken,
          }
        : {}),
    };
  }

  private async createBrief(message: string, profile: UserProfile): Promise<ProjectBrief> {
    const similarPrototypes = await this.deps.memory.searchSimilar(message);
    const extracted = await this.extractBriefFields(message);
    const fallback = inferBriefFallback(message);
    const taskType = normalizeTaskType(asString(extracted.taskType) || fallback.taskType);

    return {
      clientName: asString(extracted.clientName) || "Default Client",
      projectName: asString(extracted.projectName) || fallback.projectName,
      goal: asString(extracted.goal) || fallback.goal,
      demoScenario: asString(extracted.demoScenario) || fallback.demoScenario,
      inputDescription: asString(extracted.inputDescription) || fallback.inputDescription,
      outputDescription: asString(extracted.outputDescription) || fallback.outputDescription,
      foundationModelRole: asString(extracted.foundationModelRole) || fallback.foundationModelRole,
      profile,
      taskType,
      recommendedFoundationProviders: selectFoundationProviders({
        message,
        taskType,
        extracted,
        availableProviders: this.deps.config.demoFoundation.availableProviders,
        fallbackProvider: this.deps.config.demoFoundation.provider,
      }),
      similarPrototypes,
      deliverables: Array.isArray(extracted.deliverables) && extracted.deliverables.length
        ? extracted.deliverables
            .map(String)
            .filter(Boolean)
        : fallback.deliverables,
      constraints: [
        ...(Array.isArray(extracted.constraints)
          ? extracted.constraints.map(String).filter(Boolean)
          : fallback.constraints),
        "Use the configured foundation model provider for deployed demo calls.",
        "Do not expose secrets in frontend code.",
      ],
    };
  }

  private async extractBriefFields(message: string): Promise<Record<string, unknown>> {
    return this.deps.orchestrator.extractBriefFields(message);
  }

  private async extractChangeRequest(source: string): Promise<string> {
    return this.deps.orchestrator.extractChangeRequest(source);
  }

  private async getCapabilityTaxonomy(): Promise<Awaited<ReturnType<ConversationOrchestrator["buildTaxonomy"]>>> {
    const now = Date.now();
    if (this.capabilityTaxonomyCache && now - this.capabilityTaxonomyCache.loadedAt < 5 * 60_000) {
      return this.capabilityTaxonomyCache.value;
    }
    const taxonomy = await this.deps.orchestrator.buildTaxonomy();
    this.capabilityTaxonomyCache = { value: taxonomy, loadedAt: now };
    return taxonomy;
  }

  private createVirtualContext(userId: number, projectSlug: string): Context {
    return {
      from: { id: userId } as Context["from"],
      reply: async (text: string) => {
        this.appendMiniAppMessage({
          userId,
          projectSlug,
          role: "system",
          text,
          isIntermediate: false,
          isFinal: true,
        });
        return undefined as never;
      },
    } as unknown as Context;
  }

  private appendMiniAppMessage(args: {
    userId: number;
    projectSlug: string;
    role: MiniAppChatMessage["role"];
    text: string;
    sourceAgent?: MiniAppChatMessage["sourceAgent"];
    stage?: MiniAppChatMessage["stage"];
    isIntermediate: boolean;
    isFinal: boolean;
  }): void {
    const key = this.getConversationKey(args.userId, args.projectSlug);
    const messages = this.miniAppMessages.get(key) ?? [];
    messages.push({
      id: `msg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      dialogId: key,
      projectSlug: args.projectSlug,
      role: args.role,
      text: args.text,
      sourceAgent: args.sourceAgent,
      stage: args.stage,
      isIntermediate: args.isIntermediate,
      isFinal: args.isFinal,
      createdAt: new Date().toISOString(),
    });
    this.miniAppMessages.set(key, messages.slice(-MINIAPP_MESSAGES_LIMIT));
    this.scheduleConversationStateSave(args.userId, args.projectSlug);
  }

  private async ensureConversationStateLoaded(userId: number, projectSlug: string): Promise<void> {
    const key = this.getConversationKey(userId, projectSlug);
    if (this.loadedConversationKeys.has(key)) return;

    const pending = this.loadingConversationKeys.get(key);
    if (pending) {
      await pending;
      return;
    }

    const loader = (async () => {
      const stored = await this.deps.memory.readDialogState({
        clientSlug: MEMORY_CLIENT_SLUG,
        projectSlug,
        userId,
      });
      if (stored.notes.length) {
        this.projectConversations.set(key, stored.notes.slice(-MINIAPP_NOTES_LIMIT));
      }
      if (stored.messages.length) {
        this.miniAppMessages.set(key, stored.messages.slice(-MINIAPP_MESSAGES_LIMIT));
      }
      this.loadedConversationKeys.add(key);
      this.addKnownProject(userId, projectSlug);
    })().finally(() => {
      this.loadingConversationKeys.delete(key);
    });

    this.loadingConversationKeys.set(key, loader);
    await loader;
  }

  private scheduleConversationStateSave(userId: number, projectSlug: string): void {
    const key = this.getConversationKey(userId, projectSlug);
    const existingTimer = this.pendingConversationSaves.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      void this.persistConversationState(key);
    }, 200);
    this.pendingConversationSaves.set(key, timer);
  }

  private async persistConversationState(key: string): Promise<void> {
    this.pendingConversationSaves.delete(key);
    const parsed = this.parseConversationKey(key);
    if (!parsed) return;
    const notes = this.projectConversations.get(key) ?? [];
    const messages = this.miniAppMessages.get(key) ?? [];
    try {
      await this.deps.memory.writeDialogState({
        clientSlug: MEMORY_CLIENT_SLUG,
        projectSlug: parsed.projectSlug,
        userId: parsed.userId,
        notes: notes.slice(-MINIAPP_NOTES_LIMIT),
        messages: messages.slice(-MINIAPP_MESSAGES_LIMIT),
      });
    } catch (error) {
      console.warn(`Failed to persist dialog state for ${key}`, error);
    }
  }

  private parseConversationKey(key: string): { userId: number; projectSlug: string } | undefined {
    const separatorIndex = key.indexOf(":");
    if (separatorIndex <= 0) return undefined;
    const userId = Number(key.slice(0, separatorIndex));
    const projectSlug = key.slice(separatorIndex + 1);
    if (!Number.isFinite(userId) || userId <= 0 || !projectSlug) return undefined;
    return { userId, projectSlug };
  }

  private updateArtifactSnapshot(
    projectSlug: string,
    patch: Partial<ProjectArtifactSnapshot>,
  ): ProjectArtifactSnapshot {
    const previous = this.artifactSnapshots.get(projectSlug) ?? {
      projectSlug,
      deployStatus: "unknown" as const,
      lastCheckedAt: new Date().toISOString(),
    };
    const next: ProjectArtifactSnapshot = {
      ...previous,
      ...patch,
      projectSlug,
      lastCheckedAt: new Date().toISOString(),
    };
    this.artifactSnapshots.set(projectSlug, next);
    return next;
  }

  private isAllowed(userId: number | undefined): boolean {
    return Boolean(userId && this.deps.config.telegram.adminUserIds.has(userId));
  }
}

function inferProjectName(message: string): string {
  if (/satellite|спутник|сателлит|segmentation|сегментац|detect|detection|детекц|найти|обнаруж|маск|bbox|bounding|polygon|полигон/i.test(message)) {
    return "satellite-object-localization-demo";
  }
  if (/уборк|чист|мусор|гряз|пыл/i.test(message)) return "street-cleanliness-score";
  if (/пингвин/i.test(message)) return "penguin-counter";
  return slugify(message).slice(0, 48);
}

function isGenericBrief(brief: ProjectBrief, source: string): boolean {
  const genericGoal = brief.goal.includes("быстрый веб-прототип") ||
    brief.goal.includes("turns user input into desired output") ||
    brief.goal.includes("превращает пользовательский input");
  const genericIo =
    brief.inputDescription.includes("уточняемый по задаче") ||
    brief.outputDescription.includes("Структурированный output");
  const slugLooksLikeNoise = /^[0-9xy-]{12,}$/i.test(brief.projectName);
  const sourceHasRecognizableIntent =
    /фото|изображ|загруз|таблиц|excel|pdf|документ|текст|улиц|уборк|мусор|гряз|пингвин|дашборд|отчет|оцен|спутник|satellite|сегментац|segmentation|detect|detection|детекц|найти|обнаруж|маск|bbox|bounding|polygon|полигон/i.test(source);

  return slugLooksLikeNoise || ((genericGoal || genericIo) && !sourceHasRecognizableIntent);
}

function inferBriefFallback(message: string): Omit<
  ProjectBrief,
  "clientName" | "profile" | "recommendedFoundationProviders" | "similarPrototypes"
> {
  if (/satellite|спутник|сателлит|segmentation|сегментац|detect|detection|детекц|найти|обнаруж|маск|bbox|bounding|polygon|полигон/i.test(message)) {
    return {
      projectName: "satellite-object-localization-demo",
      goal: "Собрать веб-демо для детекции и сегментации объектов на спутниковом снимке по текстовым классам.",
      demoScenario:
        "Пользователь загружает спутниковое изображение и задает классы вроде buildings, roads, vegetation, water; приложение возвращает найденные объекты, bounding boxes, polygon masks и overlay поверх изображения.",
      inputDescription: "Один спутниковый снимок и список текстовых prompts/classes для детекции или сегментации.",
      outputDescription:
        "Набор объектов с label/confidence, bounding boxes, polygon masks, визуальный overlay на изображении и JSON с координатами.",
      foundationModelRole:
        "Segmind SAM3 Image принимает изображение и text prompts/classes, возвращает preview/overlay/masks для promptable segmentation; bounding boxes вычисляются из масок/полигонов для detection-режима. Кастомное обучение в MVP не используется.",
      taskType: "vision",
      deliverables: ["Web demo", "server-side visual localization API route", "canvas mask/bbox overlay", "README", "prototype.md"],
      constraints: [
        "Данных для обучения пока нет",
        "Используем внешний visual localization API без обучения",
        "Один снимок за раз",
        "Большие изображения нужно ресайзить перед API-вызовом",
        "Маски и bounding boxes являются демонстрационными и требуют проверки перед production",
      ],
    };
  }

  if (/уборк|чист|мусор|гряз|пыл|улиц/i.test(message)) {
    return {
      projectName: "street-cleanliness-score",
      goal: "Собрать веб-демо для оценки качества уборки улицы по загруженной фотографии.",
      demoScenario:
        "Пользователь загружает фото улицы; приложение возвращает оценку чистоты по 10-балльной шкале и объясняет, какие признаки повлияли на результат.",
      inputDescription: "Одно статичное фото улицы, тротуара, двора или другой городской зоны.",
      outputDescription:
        "Оценка чистоты от 1 до 10, список замеченных факторов вроде мусора, пыли или грязи, confidence и короткое объяснение.",
      foundationModelRole:
        "Foundation vision model анализирует изображение и возвращает структурированный JSON; датасет и обучение модели в MVP не используются.",
      taskType: "vision",
      deliverables: ["Web demo", "server-side vision API route", "README", "prototype.md"],
      constraints: [
        "Данных пока нет",
        "Используем foundation model без обучения",
        "Один статичный пример за раз",
        "Оценка является демонстрационной, не откалиброванной production-метрикой",
      ],
    };
  }

  return {
    projectName: inferProjectName(message),
    goal: "Собрать быстрый веб-прототип, который превращает пользовательский input в нужный output через foundation model.",
    demoScenario: "Пользователь предоставляет пример входных данных; приложение показывает структурированный результат.",
    inputDescription: "Пользовательский input, уточняемый по задаче.",
    outputDescription: "Структурированный output, который можно показать как демо.",
    foundationModelRole: "Foundation model обрабатывает input на сервере и возвращает результат для интерфейса.",
    taskType: "unknown",
    deliverables: ["Web demo", "server-side foundation model API route", "README", "prototype.md"],
    constraints: ["MVP без обучения модели", "Секреты не попадают в frontend"],
  };
}

function inferChangeBrief(
  projectSlug: string,
  changeRequest: string,
  providers: FoundationProvider[],
): ProjectBrief {
  return {
    clientName: "Default Client",
    projectName: projectSlug,
    goal: `Update existing prototype: ${changeRequest}`,
    demoScenario: "Apply the requested change to the existing deployed prototype.",
    inputDescription: "Existing project files and the user's change request.",
    outputDescription: "Updated web demo with the requested behavior or UI change.",
    foundationModelRole:
      "Keep using the configured foundation model for server-side input-to-output transformations where the existing project requires it.",
    profile: "admin",
    taskType: "unknown",
    recommendedFoundationProviders: normalizeRuntimeProviders(providers),
    similarPrototypes: [],
    deliverables: ["Updated GitHub commit", "Deploy redeploy", "Updated docs when needed"],
    constraints: ["Preserve existing project structure unless the request explicitly asks for a rewrite"],
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeTaskType(value: string): ProjectBrief["taskType"] {
  if (value === "vision" || value === "language" || value === "dashboard" || value === "api") {
    return value;
  }
  if (value === "text" || value === "document" || value === "documents") {
    return "language";
  }
  return "unknown";
}

function selectFoundationProviders(args: {
  message: string;
  taskType: ProjectBrief["taskType"];
  extracted: Record<string, unknown>;
  availableProviders: FoundationProvider[];
  fallbackProvider: FoundationProvider;
}): FoundationProvider[] {
  return routePrototypeProviders(args).providers;
}

function normalizeRuntimeProviders(providers: FoundationProvider[]): FoundationProvider[] {
  const filtered = providers.filter((provider) => provider === "anthropic" || provider === "sam3");
  return filtered.length ? [...new Set(filtered)] : ["anthropic"];
}

function formatResult(
  profile: UserProfile,
  repoUrl?: string,
  previewUrl?: string,
  evaluation?: { score: number; summary: string },
): string {
  if (profile === "client") {
    return `Готово. Лаплас собрал первый прототип.${previewUrl ? `\nДемо: ${previewUrl}` : ""}`;
  }

  return [
    `Builder finished.`,
    evaluation ? `Evaluator: accepted (${evaluation.score}/100) - ${evaluation.summary}` : undefined,
    repoUrl ? `Repo: ${repoUrl}` : undefined,
    previewUrl ? `Preview: ${previewUrl}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatEstimate(projectSlug: string, estimate: ResourceEstimate): string {
  const roleOrder: Array<ResourceEstimate["humanResources"][number]["role"]> = [
    "cto",
    "product_manager",
    "devops",
    "qa",
    "security",
  ];
  const byRole = new Map(estimate.humanResources.map((item) => [item.role, item]));
  const roleLines = roleOrder
    .map((role) => byRole.get(role))
    .filter((item): item is ResourceEstimate["humanResources"][number] => Boolean(item))
    .map((item) => {
      const title = humanRoleLabel(item.role);
      return `- ${title}: ${item.fteRange}, ${item.effortWeeks} недель, ${item.focus}`;
    });

  const techLines = estimate.technicalResources
    .slice(0, 5)
    .map((item) => `- ${item.area}: ${item.range} (${item.recommendation})`);

  return [
    `Оценка ресурсов для проекта: ${projectSlug}`,
    "",
    `${estimate.projectSummary}`,
    "",
    `Готовность к промышленному контуру: ${estimate.readinessScore}/100`,
    `Срок: ${estimate.timelineWeeks.min}-${estimate.timelineWeeks.max} недель`,
    `Бюджет: ${formatRub(estimate.budget.min)}-${formatRub(estimate.budget.max)} руб.`,
    `Примечание к бюджету: ${estimate.budget.note}`,
    "",
    "Оценка команды:",
    ...(roleLines.length ? roleLines : ["- Нет данных по ролям"]),
    "",
    "Технические ресурсы:",
    ...(techLines.length ? techLines : ["- Нет данных по тех. ресурсам"]),
    "",
    "Ключевые риски:",
    ...(estimate.risks.slice(0, 4).map((risk) => `- ${risk}`)),
    "",
    "Следующие шаги:",
    ...(estimate.nextSteps.slice(0, 4).map((step) => `- ${step}`)),
    "",
    ...(estimate.historicalDataNote ? [`Исторические данные: ${estimate.historicalDataNote}`] : []),
    ...(estimate.historicalSources?.length
      ? [
          "Источники исторических данных:",
          ...estimate.historicalSources.slice(0, 3).map((source) => `- ${source}`),
        ]
      : []),
  ].join("\n");
}

function formatFeasibilityLine(assessment: FeasibilityAssessment): string {
  const verdictLabel =
    assessment.verdict === "feasible_now"
      ? "реально сейчас"
      : assessment.verdict === "needs_scope_reduction"
        ? "условно реально, если сузить scope"
        : "нереально сейчас";
  return `Feasibility verdict: ${verdictLabel} (${assessment.verdict})`;
}

function formatFeasibilityHints(assessment: FeasibilityAssessment): string[] {
  const lines: string[] = [];
  if (assessment.summary) lines.push(`Skeptic summary: ${assessment.summary}`);
  if (assessment.blockers.length) {
    lines.push("Критичные ограничения:");
    lines.push(...assessment.blockers.slice(0, 4).map((item) => `- ${item}`));
  }
  if (assessment.scopeAdjustments.length) {
    lines.push("Как сделать задачу реалистичной:");
    lines.push(...assessment.scopeAdjustments.slice(0, 4).map((item) => `- ${item}`));
  }
  if (assessment.oneClarifyingQuestion) {
    lines.push(`Уточняющий вопрос: ${assessment.oneClarifyingQuestion}`);
  }
  return lines;
}

function formatCapabilityHints(taxonomy: CapabilityTaxonomy, text: string): string[] {
  const lowered = text.toLowerCase();
  const matched = taxonomy.archetypes
    .filter((item) => item.exampleSignals.some((signal) => lowered.includes(signal.toLowerCase())))
    .slice(0, 2);
  if (!matched.length) return [];

  const lines = ["Capability taxonomy hints:"];
  for (const item of matched) {
    lines.push(
      `- ${item.label}: ${item.currentlySupported ? "supported now" : "not fully supported"}; providers=${item.preferredProviders.join(", ")}`,
    );
    if (item.blockingReasons.length) {
      lines.push(`  blockers: ${item.blockingReasons.slice(0, 2).join("; ")}`);
    }
  }
  return lines;
}

function renderAgentModelMap(cursor: {
  builderModel?: string;
  testerModel?: string;
  revisorModel?: string;
  briefModel?: string;
  skepticModel?: string;
  estimatorModel?: string;
  reasoningEnabled?: boolean;
}): string {
  return [
    "Agent model mapping:",
    `- agent_brief: ${cursor.briefModel ?? cursor.builderModel ?? "n/a"}`,
    `- agent_skeptic: ${cursor.skepticModel ?? cursor.briefModel ?? "n/a"}`,
    `- agent_builder: ${cursor.builderModel ?? "n/a"}`,
    `- agent_tester: ${cursor.testerModel ?? cursor.builderModel ?? "n/a"}`,
    `- agent_revisor: ${cursor.revisorModel ?? cursor.testerModel ?? "n/a"}`,
    `- agent_estimator: ${cursor.estimatorModel ?? cursor.skepticModel ?? "n/a"}`,
    `- reasoning: ${cursor.reasoningEnabled === false ? "off" : "on"}`,
  ].join("\n");
}

function humanRoleLabel(role: ResourceEstimate["humanResources"][number]["role"]): string {
  if (role === "cto") return "Технический руководитель";
  if (role === "product_manager") return "Менеджер продукта";
  if (role === "devops") return "Инженер инфраструктуры";
  if (role === "qa") return "QA";
  if (role === "security") return "Инженер безопасности";
  return role;
}

function formatRub(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(value);
}

function renderProjectCard(brief: ProjectBrief, result: BuilderResult): string {
  return `# ${brief.projectName}

## Summary
${result.summary || brief.goal}

## Demo Scenario
${brief.demoScenario}

## Inputs
${brief.inputDescription}

## Domain
AI/ML prototype

## Task Type
${brief.taskType}

## Output
${brief.outputDescription}

## Approach
${brief.foundationModelRole}

## Build Status
- Evaluator: ${result.evaluation ? `accepted (${result.evaluation.score}/100)` : "not available"}
- Evaluator summary: ${result.evaluation?.summary ?? "not available"}

## Reuse Notes
Can be used as a starting point for similar ${brief.taskType} prototypes.

## Links
- Repo: ${result.repoUrl ?? "not available yet"}
- Demo: ${result.previewUrl ?? "not available yet"}

## Limitations
${result.limitations.length
    ? result.limitations.map((item) => `- ${item}`).join("\n")
    : "- Prototype quality depends on foundation model behavior and has not been validated on client data."}
`;
}

function renderChangeCard(
  projectSlug: string,
  changeRequest: string,
  result: BuilderResult,
  repoUrl?: string,
  previewUrl?: string,
): string {
  return `# ${projectSlug}

## Latest Change
${changeRequest}

## Update Result
${result.summary || "Change was applied through Laplace update flow."}

## Evaluator
${result.evaluation ? `accepted (${result.evaluation.score}/100) - ${result.evaluation.summary}` : "not available"}

## Links
- Repo: ${repoUrl ?? "not available yet"}
- Demo: ${previewUrl ?? "not available yet"}

## Notes
${result.limitations.length ? result.limitations.map((item) => `- ${item}`).join("\n") : "- Existing prototype was updated through Laplace change flow."}
`;
}

function renderProjectHistoryEntry(args: {
  type: "create" | "update";
  projectSlug: string;
  summary: string;
  repoUrl?: string;
  previewUrl?: string;
  evaluation?: EvaluationVerdict;
  notes?: string[];
  changeRequest?: string;
}): string {
  return [
    `## ${new Date().toISOString()} - ${args.type === "create" ? "create" : "update"}`,
    `Project: ${args.projectSlug}`,
    args.changeRequest ? `Change request: ${args.changeRequest}` : undefined,
    `Summary: ${args.summary || "not available"}`,
    args.evaluation ? `Evaluator: accepted (${args.evaluation.score}/100) - ${args.evaluation.summary}` : "Evaluator: not available",
    `Repo: ${args.repoUrl ?? "not available"}`,
    `Deploy: ${args.previewUrl ?? "not available"}`,
    args.notes?.length ? `Notes:\n${args.notes.map((item) => `- ${item}`).join("\n")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderHelp(): string {
  return `Привет, я Лаплас. Каждый проект — отдельный диалоговый контекст.

Команды:
/help - показать эту инструкцию
/menu - показать кнопки команд
/active - показать текущий project
/delete - удалить текущий project (локально + memory + GitHub + deploy)
/profile admin - технический режим общения
/profile client - клиентский режим без технических деталей
/mode user - только значимые workflow-события
/mode debug - подробный workflow и промежуточные события
/models - показать текущий mapping моделей агентов
/miniapp - открыть URL Telegram Mini App backend
/projects - показать список и переключение между projects
/project <name> - выбрать существующий или создать новый project-контекст
/analyze - собрать разговор в задачу, оценить feasibility и бюджет
/estimate - дать production estimate (команда/инфра/сроки/бюджет) для текущего project
/status - последние builder jobs
/confirm - подтвердить запуск ожидающей задачи
/cancel - отменить ожидающий запуск

Поток работы:
1) /project <name> (выбрать контекст)
2) обсуждение внутри этого project
3) /analyze (посмотреть задачу + verdict реалистичности)
4) /confirm (запустить)

Создание и изменение используют один и тот же flow: /analyze -> /confirm.`;
}

function commandKeyboard() {
  return Markup.keyboard([
    ["/analyze", "/confirm", "/cancel"],
    ["/projects", "/active", "/status", "/models"],
    ["/estimate", "/mode", "/miniapp"],
    ["/delete"],
    ["/help"],
  ]).resize();
}

async function removeDirIfExists(targetPath: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return "deleted";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return "not_found";
      if (code !== "ENOTEMPTY" && code !== "EBUSY") {
        return summarizeDeleteError(error);
      }
      if (attempt === 2) {
        return summarizeDeleteError(error);
      }
      await sleep(150);
    }
  }
  return "not_found";
}

function summarizeDeleteError(error: unknown): string {
  if (error instanceof Error) {
    return `error: ${error.message.slice(0, 200)}`;
  }
  return `error: ${String(error).slice(0, 200)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHealthcheckUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function workflowSourceLabel(source: WorkflowSource): string {
  if (source === "builder") return "BuilderAgent";
  if (source === "evaluator") return "Tester/Revisor";
  if (source === "deploy") return "DeployPipeline";
  if (source === "estimator") return "EstimatorAgent";
  return "Orchestrator";
}

function workflowSourceToAgent(source: WorkflowSource):
  | "agent_builder"
  | "agent_tester"
  | "agent_estimator"
  | "agent_brief"
  | undefined {
  if (source === "builder") return "agent_builder";
  if (source === "evaluator") return "agent_tester";
  if (source === "estimator") return "agent_estimator";
  if (source === "orchestrator") return "agent_brief";
  return undefined;
}

function workflowSourceToStage(source: WorkflowSource):
  | "intake"
  | "build"
  | "test"
  | "estimate"
  | "deploy" {
  if (source === "builder") return "build";
  if (source === "evaluator") return "test";
  if (source === "deploy") return "deploy";
  if (source === "estimator") return "estimate";
  return "intake";
}

function mapWorkflowEventKind(kind: WorkflowEventKind):
  | "agent_started"
  | "heartbeat"
  | "intermediate"
  | "final"
  | "error" {
  if (kind === "milestone") return "agent_started";
  return kind;
}

function compactWorkflowText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 180)}...` : normalized;
}

function renderChatSystemPrompt(profile: UserProfile): string {
  const shared = `You are Laplace, a senior AI/ML prototyping partner.

Your job is to quickly understand:
1. what input data the user has or can provide;
2. what output the user wants to show;
3. how to demonstrate input-to-output behavior in a small web app using a configured foundation model.

In normal chat, help shape vague business ideas into this input/output demo form. Do not treat every message as a build request.

Style:
- Answer in Russian.
- Be calm, direct, and professional, like a strong technical product lead.
- Do not introduce yourself repeatedly.
- Do not say "I am Laplace" unless asked who you are.
- Do not mention commands in every reply.
- Mention /analyze only when the user clearly wants to turn the discussion into an actionable build plan, or asks what to do next.
- Keep replies concise: usually 2-5 sentences.
- Prefer one useful clarifying question over a list of many questions.
- Avoid interrogation loops. Ask at most one clarifying question and only when strictly needed.
- Once input/output is sufficiently clear, stop asking extra questions and move to action.
- If the user asks casual small talk, answer naturally and briefly.
- If the user is unsure, ask about either the input or the output, whichever is less clear.
- Prefer practical prototype framing: "what do we upload/provide?" and "what should the demo return/show?"
- If the user says there is no data, do not propose collecting data or training a baseline model for the first demo. Instead, frame the MVP as a foundation-model demo on user-provided examples.
- Avoid questions about datasets, experts, labeling, or training unless the user explicitly asks to move beyond the prototype.
- Do not claim that a production model is ready. Frame early work as prototype, demo, baseline, or validation.
- Never mention Cursor to client-profile users.`;

  if (profile === "client") {
    return `${shared}

Client profile:
- Avoid implementation jargon unless the user asks.
- Explain progress and tradeoffs in business-friendly terms.
- Focus on what can be shown to a stakeholder quickly.`;
  }

  return `${shared}

Admin profile:
- You may discuss stack, APIs, data, deployment, budget, and risks.
- Still avoid sounding like a CLI manual.
- Use technical detail only when it helps the current decision.`;
}

function sanitizeChatReply(text: string): string {
  return text
    .replace(/\b(введите|используйте|отправьте)\s+`?\/analyze`?[^.。!\n]*[.。!]?/gi, "")
    .replace(/^\s*(Приветствую\.?\s*)?Я\s+[—-]?\s*Лаплас[^.\n]*[.\n]?/i, "")
    .trim();
}

function buildProjectChatSummary(memorySummary?: string, workspaceSummary?: string): string {
  const hasUsefulMemory = Boolean(memorySummary && !looksLikeBootstrapMemory(memorySummary));
  if (hasUsefulMemory && workspaceSummary) {
    return [
      `Memory summary:\n${memorySummary}`,
      `Workspace summary:\n${workspaceSummary}`,
    ].join("\n\n");
  }
  if (workspaceSummary) return `Workspace summary:\n${workspaceSummary}`;
  if (memorySummary) return `Memory summary:\n${memorySummary}`;
  return "(no saved project summary yet)";
}

function looksLikeBootstrapMemory(text: string): boolean {
  return /legacy project detected in workspace|auto-created to seed memory context/i.test(text);
}

function truncateText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...(truncated)` : text;
}

function extractFirstUrlByLabel(text: string | undefined, label: string): string | undefined {
  if (!text) return undefined;
  const regex = new RegExp(`${label}\\s*:\\s*(https?:\\/\\/[^\\s]+)`, "i");
  const match = text.match(regex);
  return match?.[1];
}
