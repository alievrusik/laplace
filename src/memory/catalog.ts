import fs from "node:fs/promises";
import path from "node:path";
import type { MiniAppChatMessage, PrototypeMatch } from "../domain/types.js";
import type { LaplaceLlm } from "../llm/laplaceLlm.js";

type DialogStatePayload = {
  notes: string[];
  messages: MiniAppChatMessage[];
  updatedAt: string;
};

export class MemoryCatalog {
  constructor(
    private readonly memoryDir: string,
    private readonly llm: LaplaceLlm,
  ) {}

  async ensureInitialized(): Promise<void> {
    await fs.mkdir(path.join(this.memoryDir, "clients"), { recursive: true });
    await fs.mkdir(path.join(this.memoryDir, "prototypes"), { recursive: true });

    const indexPath = path.join(this.memoryDir, "index.md");
    try {
      await fs.access(indexPath);
    } catch {
      await fs.writeFile(indexPath, "# Laplace Prototype Index\n\nNo prototypes yet.\n", "utf8");
    }
  }

  async searchSimilar(task: string): Promise<PrototypeMatch[]> {
    const cards = await this.readPrototypeCards();
    if (cards.length === 0) return [];

    return this.llm.completeJson<PrototypeMatch[]>([
      {
        role: "system",
        content:
          "You compare a new client prototype request with a Markdown catalog. Return up to 3 genuinely reusable matches.",
      },
      {
        role: "user",
        content: JSON.stringify({
          task,
          cards,
          expectedShape: [
            {
              slug: "prototype-slug",
              title: "Prototype title",
              reason: "Why it is similar",
              reuseNotes: "What can be reused",
            },
          ],
        }),
      },
    ]);
  }

  async writeProjectCard(args: {
    clientSlug: string;
    projectSlug: string;
    markdown: string;
  }): Promise<string> {
    const projectDir = path.join(
      this.memoryDir,
      "clients",
      args.clientSlug,
      "projects",
      args.projectSlug,
    );
    await fs.mkdir(projectDir, { recursive: true });
    const filePath = path.join(projectDir, "project.md");
    await fs.writeFile(filePath, args.markdown, "utf8");
    return filePath;
  }

  async appendProjectHistory(args: {
    clientSlug: string;
    projectSlug: string;
    entryMarkdown: string;
  }): Promise<string> {
    const projectDir = path.join(
      this.memoryDir,
      "clients",
      args.clientSlug,
      "projects",
      args.projectSlug,
    );
    await fs.mkdir(projectDir, { recursive: true });
    const filePath = path.join(projectDir, "history.md");
    const existing = await this.readTextIfExists(filePath);
    const content = existing
      ? `${existing.trimEnd()}\n\n---\n\n${args.entryMarkdown.trim()}\n`
      : `# Project History\n\n${args.entryMarkdown.trim()}\n`;
    await fs.writeFile(filePath, content, "utf8");
    return filePath;
  }

  async readProjectSummary(args: {
    clientSlug: string;
    projectSlug: string;
    maxChars?: number;
  }): Promise<string | undefined> {
    const baseDir = path.join(
      this.memoryDir,
      "clients",
      args.clientSlug,
      "projects",
      args.projectSlug,
    );
    const projectCard = await this.readTextIfExists(path.join(baseDir, "project.md"));
    const history = await this.readTextIfExists(path.join(baseDir, "history.md"));
    const combined = [
      projectCard ? `Current project card:\n${projectCard.trim()}` : undefined,
      history ? `Recent history:\n${history.trim()}` : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (!combined) return undefined;
    const limit = args.maxChars ?? 6000;
    return combined.length > limit ? `${combined.slice(0, limit)}\n...(truncated)` : combined;
  }

  async readDialogState(args: {
    clientSlug: string;
    projectSlug: string;
    userId: number;
  }): Promise<{ notes: string[]; messages: MiniAppChatMessage[] }> {
    const filePath = this.getDialogStatePath(args);
    const raw = await this.readTextIfExists(filePath);
    if (!raw) return { notes: [], messages: [] };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { notes: [], messages: [] };
    }

    if (!parsed || typeof parsed !== "object") {
      return { notes: [], messages: [] };
    }

    const payload = parsed as Partial<DialogStatePayload>;
    const notes = Array.isArray(payload.notes) ? payload.notes.map(String).filter(Boolean).slice(-120) : [];
    const messages = Array.isArray(payload.messages)
      ? payload.messages.filter(isMiniAppChatMessage).slice(-300)
      : [];
    return { notes, messages };
  }

  async writeDialogState(args: {
    clientSlug: string;
    projectSlug: string;
    userId: number;
    notes: string[];
    messages: MiniAppChatMessage[];
  }): Promise<void> {
    const filePath = this.getDialogStatePath(args);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload: DialogStatePayload = {
      notes: args.notes.slice(-120),
      messages: args.messages.slice(-300),
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  private async readPrototypeCards(): Promise<Array<{ slug: string; body: string }>> {
    const dir = path.join(this.memoryDir, "prototypes");
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const markdownFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"));

    return Promise.all(
      markdownFiles.map(async (entry) => ({
        slug: entry.name.replace(/\.md$/, ""),
        body: await fs.readFile(path.join(dir, entry.name), "utf8"),
      })),
    );
  }

  private async readTextIfExists(filePath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private getDialogStatePath(args: {
    clientSlug: string;
    projectSlug: string;
    userId: number;
  }): string {
    return path.join(
      this.memoryDir,
      "clients",
      args.clientSlug,
      "projects",
      args.projectSlug,
      "dialogs",
      `user-${Math.trunc(args.userId)}.json`,
    );
  }
}

function isMiniAppChatMessage(value: unknown): value is MiniAppChatMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MiniAppChatMessage>;
  const hasRole = candidate.role === "user" || candidate.role === "assistant" || candidate.role === "system";
  return Boolean(
    typeof candidate.id === "string" &&
      typeof candidate.dialogId === "string" &&
      typeof candidate.projectSlug === "string" &&
      hasRole &&
      typeof candidate.text === "string" &&
      typeof candidate.createdAt === "string" &&
      typeof candidate.isIntermediate === "boolean" &&
      typeof candidate.isFinal === "boolean",
  );
}
