export interface VercelProject {
  id: string;
  name: string;
  url?: string;
}

export interface VercelDeployment {
  id: string;
  url: string;
  state?: string;
  errorMessage?: string;
  inspectorUrl?: string;
}

export class VercelDeploymentError extends Error {
  readonly deploymentId: string;
  readonly state: string;
  readonly deploymentUrl?: string;
  readonly inspectorUrl?: string;

  constructor(args: {
    deploymentId: string;
    state: string;
    errorMessage?: string;
    deploymentUrl?: string;
    inspectorUrl?: string;
  }) {
    super(
      [
        `Vercel deployment ${args.deploymentId} finished with state ${args.state}`,
        args.errorMessage ? `reason: ${args.errorMessage}` : undefined,
        args.inspectorUrl ? `inspector: ${args.inspectorUrl}` : undefined,
      ]
        .filter(Boolean)
        .join("; "),
    );
    this.name = "VercelDeploymentError";
    this.deploymentId = args.deploymentId;
    this.state = args.state;
    this.deploymentUrl = args.deploymentUrl;
    this.inspectorUrl = args.inspectorUrl;
  }
}

export class DeployManager {
  constructor(
    private readonly config: {
      token: string;
      teamId?: string;
    },
  ) {}

  async createProject(name: string, gitRepo?: { repo: string; type: "github" }): Promise<VercelProject> {
    const url = new URL("https://api.vercel.com/v10/projects");
    if (this.config.teamId) url.searchParams.set("teamId", this.config.teamId);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        framework: "nextjs",
        gitRepository: gitRepo,
      }),
    });

    if (!response.ok) {
      if (response.status === 409) return this.getProject(name);
      const text = await response.text();
      throw new Error(`Vercel project creation failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { id: string; name: string; targets?: { production?: { url?: string } } };
    return {
      id: data.id,
      name: data.name,
      url: data.targets?.production?.url,
    };
  }

  async setEnvironmentVariables(
    projectName: string,
    vars: Record<string, string | undefined>,
  ): Promise<void> {
    for (const [key, value] of Object.entries(vars)) {
      if (!value) continue;
      console.log(`[vercel] setting env ${key}`);
      await this.upsertEnvironmentVariable(projectName, key, value);
    }
  }

  async createDeployment(args: {
    projectName: string;
    gitSource: {
      repoId: number;
      ref: string;
      type: "github";
    };
  }): Promise<VercelDeployment> {
    const url = new URL("https://api.vercel.com/v13/deployments");
    if (this.config.teamId) url.searchParams.set("teamId", this.config.teamId);

    const response = await this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: args.projectName,
        target: "production",
        projectSettings: {
          framework: "nextjs",
        },
        gitSource: args.gitSource,
      }),
    });

    const data = (await response.json()) as {
      id: string;
      uid?: string;
      url: string;
      readyState?: string;
      errorMessage?: string;
      inspectorUrl?: string;
    };
    return {
      id: data.uid ?? data.id,
      url: data.url.startsWith("http") ? data.url : `https://${data.url}`,
      state: data.readyState,
      errorMessage: data.errorMessage,
      inspectorUrl: data.inspectorUrl,
    };
  }

  async waitForDeployment(
    deploymentId: string,
    options?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<VercelDeployment> {
    const timeoutMs = options?.timeoutMs ?? 5 * 60 * 1000;
    const intervalMs = options?.intervalMs ?? 10 * 1000;
    const startedAt = Date.now();

    while (true) {
      const deployment = await this.getDeployment(deploymentId);
      if (deployment.state === "READY") return deployment;
      if (deployment.state === "ERROR" || deployment.state === "CANCELED") {
        throw new VercelDeploymentError({
          deploymentId,
          state: deployment.state,
          errorMessage: deployment.errorMessage,
          deploymentUrl: deployment.url,
          inspectorUrl: deployment.inspectorUrl,
        });
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Vercel deployment ${deploymentId} did not finish within ${timeoutMs}ms`);
      }
      await sleep(intervalMs);
    }
  }

  async cleanupOldDeployments(args: {
    projectId: string;
    keepDeploymentIds: string[];
    limit?: number;
  }): Promise<{ deleted: number; failed: number }> {
    const limit = args.limit ?? 20;
    const url = new URL("https://api.vercel.com/v6/deployments");
    url.searchParams.set("projectId", args.projectId);
    url.searchParams.set("limit", String(limit));
    if (this.config.teamId) url.searchParams.set("teamId", this.config.teamId);

    const response = await this.request(url, { method: "GET" });
    const data = (await response.json()) as {
      deployments?: Array<{ uid?: string; id?: string; readyState?: string }>;
    };

    const keep = new Set(args.keepDeploymentIds);
    const deletableStates = new Set(["READY", "ERROR", "CANCELED"]);
    let deleted = 0;
    let failed = 0;

    for (const deployment of data.deployments ?? []) {
      const deploymentId = deployment.uid ?? deployment.id;
      if (!deploymentId || keep.has(deploymentId)) continue;
      if (deployment.readyState && !deletableStates.has(deployment.readyState)) continue;
      try {
        await this.deleteDeployment(deploymentId);
        deleted += 1;
      } catch {
        failed += 1;
      }
    }

    return { deleted, failed };
  }

  async disableDeploymentProtection(projectId: string): Promise<void> {
    const url = new URL(`https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}`);
    if (this.config.teamId) url.searchParams.set("teamId", this.config.teamId);

    await this.request(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssoProtection: null }),
    });
  }

  async deleteProject(projectName: string): Promise<"deleted" | "not_found"> {
    const url = new URL(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}`);
    if (this.config.teamId) url.searchParams.set("teamId", this.config.teamId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(url, {
      method: "DELETE",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
      },
    }).finally(() => clearTimeout(timeout));

    if (response.status === 404) return "not_found";
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Vercel project deletion failed (${response.status}): ${text}`);
    }
    return "deleted";
  }

  private async getProject(name: string): Promise<VercelProject> {
    const url = new URL(`https://api.vercel.com/v9/projects/${encodeURIComponent(name)}`);
    if (this.config.teamId) url.searchParams.set("teamId", this.config.teamId);

    const response = await this.request(url, { method: "GET" });
    const data = (await response.json()) as { id: string; name: string; targets?: { production?: { url?: string } } };
    return {
      id: data.id,
      name: data.name,
      url: data.targets?.production?.url,
    };
  }

  private async getDeployment(id: string): Promise<VercelDeployment> {
    const url = new URL(`https://api.vercel.com/v13/deployments/${encodeURIComponent(id)}`);
    if (this.config.teamId) url.searchParams.set("teamId", this.config.teamId);

    const response = await this.request(url, { method: "GET" });
    const data = (await response.json()) as {
      id: string;
      uid?: string;
      url: string;
      readyState?: string;
      errorMessage?: string;
      inspectorUrl?: string;
    };
    return {
      id: data.uid ?? data.id,
      url: data.url.startsWith("http") ? data.url : `https://${data.url}`,
      state: data.readyState,
      errorMessage: data.errorMessage,
      inspectorUrl: data.inspectorUrl,
    };
  }

  private async deleteDeployment(id: string): Promise<void> {
    const url = new URL(`https://api.vercel.com/v13/deployments/${encodeURIComponent(id)}`);
    if (this.config.teamId) url.searchParams.set("teamId", this.config.teamId);
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
      },
    });

    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      throw new Error(`Vercel deployment deletion failed (${response.status}): ${text}`);
    }
  }

  private async upsertEnvironmentVariable(
    projectName: string,
    key: string,
    value: string,
  ): Promise<void> {
    const envId = await this.findProjectEnvId(projectName, key);
    if (envId) {
      console.log(`[vercel] updating env ${key}`);
      await this.patchEnvironmentVariable(projectName, envId, value);
      return;
    }

    console.log(`[vercel] creating env ${key}`);
    try {
      await this.createEnvironmentVariable(projectName, key, value);
    } catch (error) {
      if (!isEnvConflictError(error)) throw error;
      const retryId = await this.findProjectEnvId(projectName, key);
      if (!retryId) throw error;
      console.log(`[vercel] env ${key} conflict on create; updating ${retryId}`);
      await this.patchEnvironmentVariable(projectName, retryId, value);
    }
  }

  private async findProjectEnvId(projectName: string, key: string): Promise<string | undefined> {
    const listUrl = new URL(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}/env`);
    if (this.config.teamId) listUrl.searchParams.set("teamId", this.config.teamId);

    const response = await this.request(listUrl, { method: "GET" });
    const data = (await response.json()) as { envs?: Array<{ id: string; key: string }> };
    return data.envs?.find((env) => env.key === key)?.id;
  }

  private async createEnvironmentVariable(projectName: string, key: string, value: string): Promise<void> {
    const createUrl = new URL(`https://api.vercel.com/v10/projects/${encodeURIComponent(projectName)}/env`);
    if (this.config.teamId) createUrl.searchParams.set("teamId", this.config.teamId);

    await this.request(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key,
        value,
        type: "encrypted",
        target: ["production", "preview", "development"],
      }),
    });
  }

  private async patchEnvironmentVariable(
    projectName: string,
    envId: string,
    value: string,
  ): Promise<void> {
    const patchUrl = new URL(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}/env/${encodeURIComponent(envId)}`,
    );
    if (this.config.teamId) patchUrl.searchParams.set("teamId", this.config.teamId);

    await this.request(patchUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value,
        target: ["production", "preview", "development"],
      }),
    });
  }

  private async deleteEnvironmentVariable(projectName: string, key: string): Promise<void> {
    const listUrl = new URL(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}/env`,
    );
    if (this.config.teamId) listUrl.searchParams.set("teamId", this.config.teamId);

    const response = await this.request(listUrl, { method: "GET" });
    const data = (await response.json()) as { envs?: Array<{ id: string; key: string }> };
    const existing = data.envs?.find((env) => env.key === key);
    if (!existing) return;

    const deleteUrl = new URL(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}/env/${existing.id}`,
    );
    if (this.config.teamId) deleteUrl.searchParams.set("teamId", this.config.teamId);

    await this.request(deleteUrl, { method: "DELETE" });
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        ...init.headers,
      },
    }).finally(() => clearTimeout(timeout));

    if (!response.ok && response.status !== 409) {
      const text = await response.text();
      throw new Error(`Vercel request failed (${response.status}): ${text}`);
    }

    return response;
  }
}

function isEnvConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ENV_CONFLICT") || message.includes("already exists");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
