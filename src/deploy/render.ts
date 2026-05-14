import type { DeployInstance, DeployProject, DeployProvider, DeployStatusSnapshot } from "./provider.js";

export class RenderDeploymentError extends Error {
  readonly deploymentId: string;
  readonly state: string;
  readonly deploymentUrl?: string;
  readonly inspectorUrl?: string;

  constructor(args: { deploymentId: string; state: string; errorMessage?: string; deploymentUrl?: string }) {
    super(
      [
        `Render deployment ${args.deploymentId} finished with state ${args.state}`,
        args.errorMessage ? `reason: ${args.errorMessage}` : undefined,
      ]
        .filter(Boolean)
        .join("; "),
    );
    this.name = "RenderDeploymentError";
    this.deploymentId = args.deploymentId;
    this.state = args.state;
    this.deploymentUrl = args.deploymentUrl;
    this.inspectorUrl = undefined;
  }
}

type RenderService = {
  id: string;
  name: string;
  serviceDetails?: {
    url?: string;
  };
};

type RenderDeploy = {
  id: string;
  status?: string;
  commit?: { id?: string };
  createdAt?: string;
  updatedAt?: string;
};

type RenderServiceListItem = RenderService | { cursor?: string; service?: RenderService };
type RenderDeployListItem = RenderDeploy | { cursor?: string; deploy?: RenderDeploy };

export class RenderDeployManager implements DeployProvider {
  readonly platform = "render" as const;
  private readonly deployServiceIndex = new Map<string, string>();
  private ownerId: string | undefined;

  constructor(
    private readonly config: {
      apiKey: string;
      subprojectName: string;
      ownerId?: string;
      mcpEnabled?: boolean;
    },
  ) {
    this.ownerId = config.ownerId;
  }

  async createProject(name: string, gitRepo?: { repo: string; type: "github" }): Promise<DeployProject> {
    const serviceName = this.toServiceName(name);
    const existing = await this.getServiceByCandidateNames(serviceName, name);
    if (existing) {
      return {
        id: existing.id,
        name,
        url: normalizeRenderUrl(existing.serviceDetails?.url),
      };
    }

    const ownerId = await this.resolveOwnerId();
    const response = await this.request(new URL("https://api.render.com/v1/services"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "web_service",
        name: serviceName,
        ownerId,
        repo: gitRepo?.repo ? `https://github.com/${gitRepo.repo}` : undefined,
        branch: "main",
        autoDeploy: "yes",
        serviceDetails: {
          env: "node",
          runtime: "node",
          pullRequestPreviewsEnabled: "no",
          envSpecificDetails: {
            buildCommand: "npm install && npm run build",
            startCommand: "npm run start",
          },
        },
      }),
    });
    const createdPayload = (await response.json()) as RenderService | { service?: RenderService };
    const created = unwrapService(createdPayload);
    if (!created?.id) {
      throw new Error(`Render create service response missing id for ${serviceName}`);
    }
    return {
      id: created.id,
      name,
      url: normalizeRenderUrl(created.serviceDetails?.url),
    };
  }

  async setEnvironmentVariables(projectName: string, vars: Record<string, string | undefined>): Promise<void> {
    const service = await this.requireService(projectName);
    const envVars = Object.entries(vars)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => ({ key, value: String(value) }));
    if (!envVars.length) return;

    const endpoint = new URL(`https://api.render.com/v1/services/${encodeURIComponent(service.id)}/env-vars`);
    const payloads = [
      { envVars },
      { clearExisting: false, envVars },
      { ADD: Object.fromEntries(envVars.map((item) => [item.key, item.value])) },
    ];
    const methods: Array<"POST" | "PUT" | "PATCH"> = ["POST", "PUT", "PATCH"];

    let lastError: unknown;
    for (const method of methods) {
      for (const payload of payloads) {
        try {
          await this.request(endpoint, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          return;
        } catch (error) {
          lastError = error;
        }
      }
    }

    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
    if (/405|invalid json/i.test(errorMessage)) {
      console.warn(
        `[render] skipping env sync for ${projectName}: endpoint rejected payload (${errorMessage}).`,
      );
      return;
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async createDeployment(args: {
    projectName: string;
    gitSource: {
      repoId?: number;
      repo?: string;
      ref: string;
      type: "github";
    };
  }): Promise<DeployInstance> {
    const service = await this.requireService(args.projectName);
    const response = await this.request(
      new URL(`https://api.render.com/v1/services/${encodeURIComponent(service.id)}/deploys`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clearCache: "do_not_clear",
          deployMode: "build_and_deploy",
        }),
      },
    );
    const raw = (await response.text()).trim();
    const deploy = raw
      ? (JSON.parse(raw) as RenderDeploy)
      : (await this.listDeployments(service.id, 1))[0];
    if (!deploy?.id) {
      throw new Error(`Render deployment trigger returned no deployment id for ${args.projectName}`);
    }
    if (deploy.id) {
      this.deployServiceIndex.set(deploy.id, service.id);
    }
    return {
      id: deploy.id,
      url: normalizeRenderUrl(service.serviceDetails?.url) ?? "",
      state: deploy.status,
    };
  }

  async waitForDeployment(
    deploymentId: string,
    options?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<DeployInstance> {
    const timeoutMs = options?.timeoutMs ?? 8 * 60 * 1000;
    const intervalMs = options?.intervalMs ?? 10 * 1000;
    const startedAt = Date.now();

    while (true) {
      const deployment = await this.getDeployment(deploymentId);
      const mapped = mapRenderState(deployment.status);
      if (mapped === "ready") {
        return {
          id: deployment.id,
          url: deployment.url ?? "",
          state: deployment.status,
        };
      }
      if (mapped === "error") {
        throw new RenderDeploymentError({
          deploymentId,
          state: deployment.status ?? "unknown",
          deploymentUrl: deployment.url,
        });
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Render deployment ${deploymentId} did not finish within ${timeoutMs}ms`);
      }
      await sleep(intervalMs);
    }
  }

  async cleanupOldDeployments(_args: {
    projectId: string;
    keepDeploymentIds: string[];
    limit?: number;
  }): Promise<{ deleted: number; failed: number }> {
    // Render keeps deployment history for observability; we avoid deleting old deploys in automated flow.
    return { deleted: 0, failed: 0 };
  }

  async disableDeploymentProtection(_projectId: string): Promise<void> {
    // No-op for Render.
  }

  async deleteProject(projectName: string): Promise<"deleted" | "not_found"> {
    const service = await this.getServiceByCandidateNames(this.toServiceName(projectName), projectName);
    if (!service) return "not_found";
    const response = await this.request(
      new URL(`https://api.render.com/v1/services/${encodeURIComponent(service.id)}`),
      { method: "DELETE" },
      { allowNotFound: true },
    );
    if (response.status === 404) return "not_found";
    return "deleted";
  }

  async getProjectDeploymentStatus(projectName: string): Promise<DeployStatusSnapshot> {
    const service = await this.getServiceByCandidateNames(this.toServiceName(projectName), projectName);
    if (!service) {
      return { state: "unknown", source: "render_api" };
    }
    const deployments = await this.listDeployments(service.id, 1);
    const latest = deployments[0];
    return {
      deployUrl: normalizeRenderUrl(service.serviceDetails?.url),
      state: mapRenderState(latest?.status),
      source: "render_api",
    };
  }

  private async requireService(projectName: string): Promise<RenderService> {
    const service = await this.getServiceByCandidateNames(this.toServiceName(projectName), projectName);
    if (!service) {
      throw new Error(`Render service not found for project "${projectName}"`);
    }
    return service;
  }

  private async getServiceByCandidateNames(...names: string[]): Promise<RenderService | undefined> {
    const uniq = [...new Set(names.filter(Boolean))];
    for (const name of uniq) {
      const matched = await this.getServiceByName(name);
      if (matched) return matched;
    }
    return undefined;
  }

  private async getServiceByName(name: string): Promise<RenderService | undefined> {
    if (this.config.mcpEnabled) {
      try {
        const mcpService = await this.getServiceViaMcp(name);
        if (mcpService) return mcpService;
      } catch (error) {
        console.warn(`[render-mcp] fallback to API for service lookup ${name}:`, error);
      }
    }

    const url = new URL("https://api.render.com/v1/services");
    url.searchParams.set("name", name);
    if (this.ownerId) url.searchParams.set("ownerId", this.ownerId);
    url.searchParams.set("limit", "20");

    const response = await this.request(url, { method: "GET" });
    const payload = (await response.json()) as { services?: RenderServiceListItem[] } | RenderServiceListItem[];
    const services = parseServiceList(payload);
    return services.find((item) => item.name === name) ?? services[0];
  }

  private async getServiceViaMcp(_name: string): Promise<RenderService | undefined> {
    // Placeholder for environments that expose render MCP client libraries at runtime.
    // Current implementation keeps API fallback as the primary reliable path.
    return undefined;
  }

  private async listDeployments(serviceId: string, limit = 20): Promise<RenderDeploy[]> {
    const url = new URL(`https://api.render.com/v1/services/${encodeURIComponent(serviceId)}/deploys`);
    url.searchParams.set("limit", String(limit));
    const response = await this.request(url, { method: "GET" });
    const payload = (await response.json()) as { deploys?: RenderDeployListItem[] } | RenderDeployListItem[];
    return parseDeployList(payload);
  }

  private async getDeployment(deploymentId: string): Promise<{ id: string; status?: string; url?: string }> {
    const serviceId = this.deployServiceIndex.get(deploymentId);
    if (!serviceId) {
      return { id: deploymentId, status: "unknown" };
    }
    const deployments = await this.listDeployments(serviceId, 20);
    const deploy = deployments.find((item) => item.id === deploymentId);
    const service = await this.getServiceById(serviceId);
    return {
      id: deploymentId,
      status: deploy?.status,
      url: normalizeRenderUrl(service?.serviceDetails?.url),
    };
  }

  private async getServiceById(serviceId: string): Promise<RenderService | undefined> {
    const response = await this.request(
      new URL(`https://api.render.com/v1/services/${encodeURIComponent(serviceId)}`),
      { method: "GET" },
      { allowNotFound: true },
    );
    if (response.status === 404) return undefined;
    const payload = (await response.json()) as RenderService | { service?: RenderService };
    return unwrapService(payload);
  }

  private async resolveOwnerId(): Promise<string> {
    if (this.ownerId) return this.ownerId;
    const response = await this.request(new URL("https://api.render.com/v1/owners"), { method: "GET" });
    const payload = (await response.json()) as { owners?: Array<{ owner?: { id?: string }; id?: string }> } | Array<{
      owner?: { id?: string };
      id?: string;
    }>;
    const owners = Array.isArray(payload) ? payload : payload.owners ?? [];
    const first = owners[0];
    const id = first?.id ?? first?.owner?.id;
    if (!id) {
      throw new Error("Render ownerId is required: set RENDER_OWNER_ID in env.");
    }
    this.ownerId = id;
    return id;
  }

  private toServiceName(projectSlug: string): string {
    const prefix = normalizeName(this.config.subprojectName || "laplace-subprojects");
    const slug = normalizeName(projectSlug);
    return `${prefix}-${slug}`.slice(0, 63);
  }

  private async request(
    url: URL,
    init: RequestInit,
    options?: { allowNotFound?: boolean },
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        ...init.headers,
      },
    }).finally(() => clearTimeout(timeout));

    if (options?.allowNotFound && response.status === 404) return response;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Render request failed (${response.status}): ${text}`);
    }
    return response;
  }
}

function normalizeName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "service";
}

function normalizeRenderUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function mapRenderState(status?: string): "unknown" | "building" | "ready" | "error" {
  if (!status) return "unknown";
  const normalized = status.toLowerCase();
  if (normalized === "live" || normalized === "deployed") return "ready";
  if (normalized.includes("fail") || normalized.includes("canceled")) return "error";
  if (
    normalized.includes("build") ||
    normalized.includes("pending") ||
    normalized.includes("queued") ||
    normalized.includes("created")
  ) {
    return "building";
  }
  return "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseServiceList(payload: { services?: RenderServiceListItem[] } | RenderServiceListItem[]): RenderService[] {
  const items = Array.isArray(payload) ? payload : payload.services ?? [];
  return items
    .map((item) => unwrapService(item))
    .filter((service): service is RenderService => Boolean(service?.id));
}

function parseDeployList(payload: { deploys?: RenderDeployListItem[] } | RenderDeployListItem[]): RenderDeploy[] {
  const items = Array.isArray(payload) ? payload : payload.deploys ?? [];
  return items
    .map((item) => unwrapDeploy(item))
    .filter((deploy): deploy is RenderDeploy => Boolean(deploy?.id));
}

function unwrapService(item: RenderServiceListItem | (RenderService | { service?: RenderService })): RenderService | undefined {
  if (!item) return undefined;
  if ("id" in item && typeof item.id === "string") return item;
  if ("service" in item && item.service && typeof item.service.id === "string") return item.service;
  return undefined;
}

function unwrapDeploy(item: RenderDeployListItem | (RenderDeploy | { deploy?: RenderDeploy })): RenderDeploy | undefined {
  if (!item) return undefined;
  if ("id" in item && typeof item.id === "string") return item;
  if ("deploy" in item && item.deploy && typeof item.deploy.id === "string") return item.deploy;
  return undefined;
}
