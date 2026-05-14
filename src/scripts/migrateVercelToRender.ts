import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/env.js";
import { RenderDeployManager } from "../deploy/render.js";
import { DeployManager as VercelDeployManager } from "../deploy/vercel.js";

type CliArgs = {
  apply: boolean;
  limit?: number;
  project?: string;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (!config.deploy.render.apiKey) {
    throw new Error("RENDER_API_KEY is required for migration");
  }

  const render = new RenderDeployManager({
    apiKey: config.deploy.render.apiKey,
    ownerId: config.deploy.render.ownerId,
    subprojectName: config.deploy.render.subprojectName,
    mcpEnabled: config.deploy.render.mcpEnabled,
  });
  const vercel = config.vercel.token
    ? new VercelDeployManager({
        token: config.vercel.token,
        teamId: config.vercel.teamId,
      })
    : undefined;

  const projects = await collectProjectSlugs(config.paths.workspaceDir, config.paths.memoryDir);
  const filtered = args.project
    ? projects.filter((slug) => slug === args.project)
    : args.limit
      ? projects.slice(0, args.limit)
      : projects;

  if (!filtered.length) {
    console.log("[migration] no projects found");
    return;
  }

  console.log(
    `[migration] mode=${args.apply ? "apply" : "dry-run"}, projects=${filtered.length}, source=vercel, target=render`,
  );

  for (const slug of filtered) {
    const repoFullName = `${config.github.owner}/${slug}`;
    const sourceStatus: { state: "unknown" | "building" | "ready" | "error"; deployUrl?: string } = vercel
      ? await vercel.getProjectDeploymentStatus(slug).catch(() => ({ state: "unknown" as const }))
      : { state: "unknown" as const };
    console.log(
      `[migration] ${slug} sourceState=${sourceStatus.state}${sourceStatus.deployUrl ? ` sourceUrl=${sourceStatus.deployUrl}` : ""}`,
    );

    if (!args.apply) {
      console.log(
        `[migration][dry-run] would ensure Render service, sync env, deploy, and append memory history for ${slug}`,
      );
      continue;
    }

    const project = await render.createProject(slug, {
      type: "github",
      repo: repoFullName,
    });
    await render.setEnvironmentVariables(slug, buildDemoFoundationEnv(config));
    const started = await render.createDeployment({
      projectName: slug,
      gitSource: {
        type: "github",
        repo: repoFullName,
        ref: "main",
      },
    });
    const finished = await render.waitForDeployment(started.id);
    const deployUrl = finished.url || project.url;
    console.log(`[migration] ${slug} migrated deploy=${deployUrl ?? "n/a"}`);
    await appendMigrationHistory({
      memoryDir: config.paths.memoryDir,
      projectSlug: slug,
      oldUrl: sourceStatus.deployUrl,
      newUrl: deployUrl,
    });
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (token === "--limit") {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value > 0) args.limit = Math.floor(value);
      index += 1;
      continue;
    }
    if (token === "--project") {
      const value = argv[index + 1];
      if (value) args.project = value.trim();
      index += 1;
    }
  }
  return args;
}

async function collectProjectSlugs(workspaceDir: string, memoryDir: string): Promise<string[]> {
  const workspace = await listDirectoryNames(workspaceDir);
  const memoryProjectsDir = path.join(memoryDir, "clients", "default-client", "projects");
  const memory = await listDirectoryNames(memoryProjectsDir);
  return [...new Set([...workspace, ...memory])].sort();
}

async function listDirectoryNames(targetDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function buildDemoFoundationEnv(config: ReturnType<typeof loadConfig>): Record<string, string | undefined> {
  const available = config.demoFoundation.availableProviders;
  return {
    DEMO_FOUNDATION_PROVIDER: config.demoFoundation.provider,
    DEMO_FOUNDATION_PROVIDERS: available.join(","),
    AVAILABLE_FOUNDATION_PROVIDERS: available.join(","),
    ANTHROPIC_API_KEY: config.demoFoundation.anthropicApiKey,
    ANTHROPIC_MODEL: config.demoFoundation.anthropicModel,
    ANTHROPIC_PROXY_URL: config.demoFoundation.deployUseAnthropicProxy
      ? config.demoFoundation.anthropicProxyUrl
      : undefined,
    ANTHROPIC_PROXY_CA_CERT_BASE64: config.demoFoundation.deployUseAnthropicProxy
      ? config.demoFoundation.anthropicProxyCaCertBase64
      : undefined,
    DEMO_VLLM_BASE_URL: config.demoFoundation.vllmBaseURL,
    DEMO_VLLM_API_KEY: config.demoFoundation.vllmApiKey,
    DEMO_VLLM_MODEL: config.demoFoundation.vllmModel,
    SAM3_API_KEY: config.demoFoundation.sam3ApiKey,
    SAM3_API_BASE_URL: config.demoFoundation.sam3ApiBaseURL,
    GIGACHAT_BASE_URL: config.demoFoundation.gigachat.baseURL,
    GIGACHAT_AUTH_URL: config.demoFoundation.gigachat.authURL,
    GIGACHAT_SCOPE: config.demoFoundation.gigachat.scope,
    GIGACHAT_MODEL: config.demoFoundation.gigachat.model,
    GIGACHAT_EMBEDDINGS_MODEL: config.demoFoundation.gigachat.embeddingsModel,
    GIGACHAT_STT_MODEL: config.demoFoundation.gigachat.sttModel,
    GIGACHAT_VERIFY_SSL_CERTS: String(config.demoFoundation.gigachat.verifySslCerts),
    GIGACHAT_CLIENT_ID: config.demoFoundation.gigachat.clientId,
    GIGACHAT_CLIENT_SECRET: config.demoFoundation.gigachat.clientSecret,
    GIGACHAT_ACCESS_TOKEN: config.demoFoundation.gigachat.accessToken,
  };
}

async function appendMigrationHistory(args: {
  memoryDir: string;
  projectSlug: string;
  oldUrl?: string;
  newUrl?: string;
}): Promise<void> {
  const historyPath = path.join(
    args.memoryDir,
    "clients",
    "default-client",
    "projects",
    args.projectSlug,
    "history.md",
  );
  const existing = await readTextIfExists(historyPath);
  const entry = [
    `## ${new Date().toISOString()} - migration`,
    `Project: ${args.projectSlug}`,
    "Summary: Deployment migrated from Vercel to Render.",
    `Previous deploy: ${args.oldUrl ?? "not available"}`,
    `Current deploy: ${args.newUrl ?? "not available"}`,
    "Notes:",
    "- Vercel resources are kept as legacy fallback.",
  ].join("\n");
  const content = existing
    ? `${existing.trimEnd()}\n\n---\n\n${entry}\n`
    : `# Project History\n\n${entry}\n`;
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.writeFile(historyPath, content, "utf8");
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
