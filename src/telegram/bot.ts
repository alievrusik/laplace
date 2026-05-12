import { Markup, Telegraf } from "telegraf";
import fs from "node:fs/promises";
import path from "node:path";
import type { Context } from "telegraf";
import type { BudgetGuard } from "../budget/guard.js";
import type { ProjectBuilder } from "../builder/projectBuilder.js";
import type { AppConfig } from "../config/env.js";
import {
  VercelDeploymentError,
  type DeployManager,
  type VercelDeployment,
  type VercelProject,
} from "../deploy/vercel.js";
import { slugify } from "../domain/slug.js";
import type {
  BuilderResult,
  EvaluationVerdict,
  FoundationProvider,
  ProjectBrief,
  ResourceEstimate,
  UserProfile,
} from "../domain/types.js";
import type { JobRunner } from "../jobs/runner.js";
import type { LaplaceLlm } from "../llm/laplaceLlm.js";
import type { MemoryCatalog } from "../memory/catalog.js";
import type { GitSync } from "../provision/gitSync.js";
import type { ProjectProvisioner } from "../provision/github.js";
import type { ResourceEstimator } from "../resource/estimator.js";
import { createTelegramAgent } from "./proxy.js";

type PendingAction = {
  projectSlug: string;
  brief: ProjectBrief;
  source: string;
  mode: "create" | "update";
};

const MAX_VERCEL_RECOVERY_ATTEMPTS = 2;
const VERCEL_HEALTHCHECK_TIMEOUT_MS = 15000;

export class TelegramBot {
  private readonly bot: Telegraf;
  private readonly profiles = new Map<number, UserProfile>();
  private readonly projectConversations = new Map<string, string[]>();
  private readonly knownProjectsByUser = new Map<number, Set<string>>();
  private readonly activeProjects = new Map<number, string>();
  private readonly pendingConfirmations = new Map<number, PendingAction>();
  private readonly pendingDeletes = new Map<number, string>();
  private readonly autoAnalyzeCheckpoint = new Map<string, number>();

  constructor(
    private readonly deps: {
      config: AppConfig;
      llm: LaplaceLlm;
      memory: MemoryCatalog;
      estimator: ResourceEstimator;
      budget: BudgetGuard;
      jobs: JobRunner;
      provisioner: ProjectProvisioner;
      gitSync: GitSync;
      builder: ProjectBuilder;
      deploy: DeployManager;
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
    this.bot.stop(signal);
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

    this.bot.command("profile", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      const text = ctx.message.text;
      const nextProfile = text.includes("client") ? "client" : "admin";
      this.profiles.set(ctx.from.id, nextProfile);
      await ctx.reply(`Профиль общения переключен: ${nextProfile}.`);
    });

    this.bot.command("status", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;
      const jobs = this.deps.jobs.list().slice(0, 5);
      if (jobs.length === 0) {
        await ctx.reply("Активных задач пока нет.");
        return;
      }

      await ctx.reply(jobs.map((job) => `${job.id}: ${job.status} - ${job.brief.projectName}`).join("\n"));
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
      await ctx.reply(`Считаю production estimate для ${activeProject}...`);
      const estimate = await this.deps.estimator.estimateForProject({
        projectSlug: activeProject,
        conversationNotes: notes,
      });
      await ctx.reply(formatEstimate(activeProject, estimate));
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
          "Будет удалено локально, в memory, GitHub и Vercel.",
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
            `Vercel project/deployments: ${summary.vercel}`,
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
      const reply = await this.chatReply(ctx.from.id, activeProject, message, profile);
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
    const known = [...(this.knownProjectsByUser.get(userId) ?? new Set<string>())];
    return [...new Set([...workspace, ...known])].sort();
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
    this.projectConversations.set(key, notes.slice(-40));
    this.addKnownProject(userId, project);
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
    let brief: ProjectBrief;
    let pendingSource = source;

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

      await ctx.reply(
        [
          autoTriggered ? "Авто-analyze: контекст проекта собран, подготовил update-запрос." : undefined,
          "Режим: update existing project",
          "",
          `Проект: ${activeProject}`,
          `Change request: ${changeRequest}`,
          `Providers: ${providers}`,
          "",
          `Budget risk: ${estimate.risk}`,
          ...estimate.notes,
          "",
          "Если все ок, отправь /confirm. Если нет — уточни, что именно менять в текущем проекте, и снова /analyze.",
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
          "",
          "Похожие прототипы:",
          similar,
          "",
          `Budget risk: ${estimate.risk}`,
          ...estimate.notes,
          "",
          "Если все ок, отправь /confirm. Если нет — допиши требования обычным сообщением и снова отправь /analyze.",
        ]
          .filter(Boolean)
          .join("\n"),
      );
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
    for (const [userId, pending] of this.pendingConfirmations.entries()) {
      if (pending.projectSlug === projectSlug) this.pendingConfirmations.delete(userId);
    }
  }

  private async deleteProjectEverywhere(projectSlug: string): Promise<{
    workspace: string;
    memory: string;
    github: string;
    vercel: string;
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
    const vercel = await this.deps.deploy.deleteProject(projectSlug).catch((error) =>
      summarizeDeleteError(error),
    );

    return { workspace, memory, github, vercel };
  }

  private async chatReply(userId: number, project: string, message: string, profile: UserProfile): Promise<string> {
    const fallback =
      "Понял. Давай разберем задачу: какой результат ты хочешь показать клиенту в первом прототипе?";
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

      const vercel = await this.runVercelPipelineWithSelfHealing({
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
        previewUrl: vercel.deployment.url ?? (vercel.project.url ? `https://${vercel.project.url}` : undefined),
      };

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

      await ctx.reply(formatResult(brief.profile, result.repoUrl, result.previewUrl, result.evaluation));
      return result;
    }).then(async (finalJob) => {
      if (finalJob.status === "failed") {
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
      await ctx.reply(
        `Не удалось получить итоговый статус задачи ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private async launchChangeJob(ctx: Context, projectSlug: string, changeRequest: string): Promise<void> {
    const repo = await this.deps.provisioner.resolveExisting(projectSlug);
    const brief = inferChangeBrief(projectSlug, changeRequest, this.deps.config.demoFoundation.availableProviders);
    const job = this.deps.jobs.create(brief);
    await ctx.reply(`Запускаю change job: ${job.id}`);

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

      await this.notifyStage(ctx, job.id, "запускаю Vercel redeploy");
      const vercel = await this.runVercelPipelineWithSelfHealing({
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
        markdown: renderChangeCard(projectSlug, changeRequest, builderResult, repo.repoUrl, vercel.deployment.url),
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
          previewUrl: vercel.deployment.url,
          evaluation: builderResult.evaluation,
          notes: builderResult.limitations,
        }),
      });
      console.log(`Updated memory card: ${cardPath}`);

      await ctx.reply(
        [
          `Готово, изменения отправлены.`,
          builderResult.evaluation
            ? `Evaluator: accepted (${builderResult.evaluation.score}/100)`
            : undefined,
          `Repo: ${repo.repoUrl}`,
          `Deploy: ${vercel.deployment.url}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );

      return {
        ...builderResult,
        repoUrl: repo.repoUrl,
        previewUrl: vercel.deployment.url,
      };
    }).then(async (finalJob) => {
      if (finalJob.status === "failed") {
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
      await ctx.reply(
        `Не удалось получить итоговый статус задачи ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private async forwardBuilderEvent(ctx: Context, jobId: string, message: string): Promise<void> {
    if (!this.shouldForwardBuilderEvent(message)) return;
    await ctx.reply(`[${jobId}] ${message}`);
  }

  private shouldForwardBuilderEvent(message: string): boolean {
    return (
      message.startsWith("Cursor Agent") ||
      message.startsWith("Cursor agent") ||
      message.startsWith("Cursor run started") ||
      message.startsWith("Cursor status") ||
      message.startsWith("Cursor tool") ||
      message.startsWith("Builder attempt") ||
      message.startsWith("Evaluator")
    );
  }

  private async runVercelPipelineWithSelfHealing(args: {
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
  }): Promise<{ project: VercelProject; deployment: VercelDeployment }> {
    let finalProject: VercelProject | undefined;
    let finalDeployment: VercelDeployment | undefined;

    for (let attempt = 1; attempt <= MAX_VERCEL_RECOVERY_ATTEMPTS + 1; attempt += 1) {
      let stage = "create_project";
      await this.notifyStage(
        args.ctx,
        args.jobId,
        `запускаю Vercel pipeline (attempt ${attempt}/${MAX_VERCEL_RECOVERY_ATTEMPTS + 1})`,
      );
      try {
        await this.notifyStage(args.ctx, args.jobId, `создаю/обновляю Vercel project ${args.projectSlug}`);
        finalProject = await this.deps.deploy.createProject(args.projectSlug, {
          type: "github",
          repo: args.repoFullName,
        });

        stage = "disable_protection";
        await this.notifyStage(args.ctx, args.jobId, "отключаю deployment protection");
        await this.deps.deploy.disableDeploymentProtection(finalProject.id);

        stage = "set_env";
        await this.notifyStage(args.ctx, args.jobId, "синхронизирую Vercel environment variables");
        await this.deps.deploy.setEnvironmentVariables(args.projectSlug, args.envVars);

        stage = "create_deploy";
        await this.notifyStage(args.ctx, args.jobId, "запускаю Vercel deployment");
        const startedDeployment = await this.deps.deploy.createDeployment({
          projectName: args.projectSlug,
          gitSource: {
            type: "github",
            repoId: args.repoId,
            ref: "main",
          },
        });
        stage = "wait_build";
        await this.notifyStage(args.ctx, args.jobId, "жду завершения Vercel build");
        finalDeployment = await this.deps.deploy.waitForDeployment(startedDeployment.id);

        stage = "healthcheck";
        await this.notifyStage(args.ctx, args.jobId, "выполняю healthcheck на задеплоенном проекте");
        await this.healthcheckDeployment(finalDeployment.url);

        stage = "cleanup";
        await this.notifyStage(args.ctx, args.jobId, "очищаю старые Vercel deployment");
        const cleaned = await this.deps.deploy.cleanupOldDeployments({
          projectId: finalProject.id,
          keepDeploymentIds: [finalDeployment.id],
        });
        if (cleaned.deleted || cleaned.failed) {
          await this.notifyStage(
            args.ctx,
            args.jobId,
            `Vercel cleanup: удалено ${cleaned.deleted}, ошибок ${cleaned.failed}`,
          );
        }
        break;
      } catch (error) {
        const errorSummary = summarizeDeleteError(error);
        await this.notifyStage(
          args.ctx,
          args.jobId,
          `Vercel pipeline failed (attempt ${attempt}/${MAX_VERCEL_RECOVERY_ATTEMPTS + 1}): ${errorSummary}`,
        );
        if (attempt > MAX_VERCEL_RECOVERY_ATTEMPTS) throw error;

        await this.notifyStage(
          args.ctx,
          args.jobId,
          `передаю ошибку Vercel (${stage}) билдеру для авто-фикса (${attempt}/${MAX_VERCEL_RECOVERY_ATTEMPTS})`,
        );
        const fixRequest = this.renderVercelFixRequest({
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
          message: `Fix ${args.projectSlug}: recover from Vercel deploy failure #${attempt}`,
          authorName: args.gitAuthorName,
          authorEmail: args.gitAuthorEmail,
        });
      }
    }

    if (!finalProject || !finalDeployment) {
      throw new Error("Vercel deployment recovery finished without a deployment result");
    }

    return { project: finalProject, deployment: finalDeployment };
  }

  private renderVercelFixRequest(args: { fixContext: string; stage: string; error: unknown }): string {
    const failure = this.describeDeployError(args.error);
    return [
      "Vercel pipeline failed after pushing current code to main.",
      args.fixContext,
      "",
      `Failed stage: ${args.stage}`,
      "",
      "Observed deploy error:",
      failure,
      "",
      "What to do:",
      "- Identify and fix the root cause for this Vercel stage failure.",
      "- If env vars/config are inconsistent, align project code and runtime configuration so env sync and deploy both succeed.",
      "- Run local checks that map to Vercel expectations (at minimum npm run build and npm run typecheck when available).",
      "- Ensure deployed app responds successfully after build (basic healthcheck on / should return non-error).",
      "- Update config/docs only if needed for successful deployment.",
      "- Keep fixes minimal, safe, and production-ready.",
    ].join("\n");
  }

  private describeDeployError(error: unknown): string {
    if (error instanceof VercelDeploymentError) {
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
    const target = normalizeHealthcheckUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VERCEL_HEALTHCHECK_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(target, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(
        `Vercel healthcheck failed for ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 500) {
      throw new Error(`Vercel healthcheck returned ${response.status} for ${target}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = (await response.text()).trim();
    if (!body) {
      throw new Error(`Vercel healthcheck returned empty body for ${target}`);
    }

    if (contentType && !/text\/html|application\/json|text\/plain/i.test(contentType)) {
      throw new Error(`Vercel healthcheck returned unexpected content-type "${contentType}" for ${target}`);
    }
  }

  private async notifyStage(ctx: Context, jobId: string, message: string): Promise<void> {
    const line = `[${jobId}] ${message}`;
    console.log(line);
    await ctx.reply(line);
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
                : this.deps.config.demoFoundation.vercelUseAnthropicProxy
                  ? this.deps.config.demoFoundation.anthropicProxyUrl
                  : undefined,
            ANTHROPIC_PROXY_CA_CERT_BASE64:
              mode === "sanitized"
                ? configured(
                    this.deps.config.demoFoundation.anthropicProxyCaCertBase64 ||
                      this.deps.config.demoFoundation.anthropicProxyCaCertPath,
                  )
                : this.deps.config.demoFoundation.vercelUseAnthropicProxy
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

  private async extractChangeRequest(source: string): Promise<string> {
    const fallback = source.trim().slice(0, 4000);
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
  const genericGoal = brief.goal.includes("быстрый Vercel-прототип") ||
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
      deliverables: ["Vercel web demo", "server-side visual localization API route", "canvas mask/bbox overlay", "README", "prototype.md"],
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
      deliverables: ["Vercel web demo", "server-side vision API route", "README", "prototype.md"],
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
    goal: "Собрать быстрый Vercel-прототип, который превращает пользовательский input в нужный output через foundation model.",
    demoScenario: "Пользователь предоставляет пример входных данных; приложение показывает структурированный результат.",
    inputDescription: "Пользовательский input, уточняемый по задаче.",
    outputDescription: "Структурированный output, который можно показать как демо.",
    foundationModelRole: "Foundation model обрабатывает input на сервере и возвращает результат для интерфейса.",
    taskType: "unknown",
    deliverables: ["Vercel web demo", "server-side foundation model API route", "README", "prototype.md"],
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
    outputDescription: "Updated Vercel demo with the requested behavior or UI change.",
    foundationModelRole:
      "Keep using the configured foundation model for server-side input-to-output transformations where the existing project requires it.",
    profile: "admin",
    taskType: "unknown",
    recommendedFoundationProviders: providers,
    similarPrototypes: [],
    deliverables: ["Updated GitHub commit", "Vercel redeploy", "Updated docs when needed"],
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
  const available = args.availableProviders.length ? args.availableProviders : [args.fallbackProvider];
  const requested = parseFoundationProviders(args.extracted.recommendedFoundationProviders)
    .concat(parseFoundationProviders(args.extracted.recommendedFoundationProvider))
    .filter((provider) => available.includes(provider));

  const needsLocalization =
    /segmentation|сегментац|detect|detection|детекц|найти|обнаруж|bbox|bounding|маск|polygon|полигон/i.test(
      args.message,
    );
  const needsVision =
    args.taskType === "vision" || /фото|image|изображ|спутник|satellite|снимок/i.test(args.message);
  const needsLanguage =
    args.taskType === "language" || /текст|document|документ|pdf|отчет|summary|классиф/i.test(args.message);

  const selected: FoundationProvider[] = [];
  if (needsLocalization && available.includes("sam3")) selected.push("sam3");
  if ((needsVision || needsLanguage) && available.includes("anthropic")) selected.push("anthropic");
  if (needsLanguage && available.includes("vllm")) selected.push("vllm");
  selected.push(...requested);

  if (!selected.length) selected.push(available[0] ?? args.fallbackProvider);
  return uniqueProviders(selected);
}

function parseFoundationProviders(value: unknown): FoundationProvider[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return values
    .map((item) => String(item).trim())
    .filter((provider): provider is FoundationProvider =>
      provider === "anthropic" || provider === "vllm" || provider === "sam3",
    );
}

function uniqueProviders(providers: FoundationProvider[]): FoundationProvider[] {
  return [...new Set(providers)];
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

function renderBriefExtractionPrompt(): string {
  return `Extract a practical AI/ML prototype brief from a messy Russian conversation.

Important:
- Ignore casual chatter such as "как дела" unless it is part of the actual project.
- Your main job is to quickly identify the user's input data and desired output.
- Convert that into the fastest Vercel web demo where a configured foundation model transforms the input into the output.
- Prefer a foundation-model prototype when there is no dataset, no training plan, or the user wants a quick demo.
- Foundation providers: do not recommend or assume that all available foundation models must be used. Infer which providers (sam3, anthropic, vllm, etc.) are actually needed to fulfill the user's task and list only those in recommendedFoundationProviders; omit providers that add no necessary capability.
- The prototype should be simple: upload/paste/provide input, call a server-side foundation model, show structured output.
- Do not overstate accuracy. If the user asks for "maximum accuracy" but there is no labeled dataset, frame this as calibrated prototype output with limitations.
- Pick a short English kebab-case projectName suitable for GitHub/Vercel. Use semantic names, not generic words like "foundation".
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
  "deliverables": ["Vercel web demo", "server-side vision API route", "README", "prototype.md"],
  "constraints": ["No dataset is available", "Use foundation model only for MVP", "One static image at a time", "Score is not a calibrated production metric"]
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
/delete - удалить текущий project (локально + memory + GitHub + Vercel)
/profile admin - технический режим общения
/profile client - клиентский режим без технических деталей
/projects - показать список и переключение между projects
/project <name> - выбрать существующий или создать новый project-контекст
/analyze - собрать разговор в задачу, найти похожие проекты и оценить бюджет
/estimate - дать production estimate (команда/инфра/сроки/бюджет) для текущего project
/status - последние builder jobs
/confirm - подтвердить запуск ожидающей задачи
/cancel - отменить ожидающий запуск

Поток работы:
1) /project <name> (выбрать контекст)
2) обсуждение внутри этого project
3) /analyze (посмотреть задачу)
4) /confirm (запустить)

Создание и изменение используют один и тот же flow: /analyze -> /confirm.`;
}

function commandKeyboard() {
  return Markup.keyboard([
    ["/analyze", "/confirm", "/cancel"],
    ["/projects", "/active", "/status"],
    ["/estimate", "/delete", "/help"],
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

function renderChatSystemPrompt(profile: UserProfile): string {
  const shared = `You are Laplace, a senior AI/ML prototyping partner.

Your job is to quickly understand:
1. what input data the user has or can provide;
2. what output the user wants to show;
3. how to demonstrate input-to-output behavior in a small Vercel web app using a configured foundation model.

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
