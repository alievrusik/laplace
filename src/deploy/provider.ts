export type DeployPlatform = "vercel" | "render";
export type DeployState = "unknown" | "building" | "ready" | "error";

export interface DeployProject {
  id: string;
  name: string;
  url?: string;
}

export interface DeployInstance {
  id: string;
  url: string;
  state?: string;
  errorMessage?: string;
  inspectorUrl?: string;
}

export interface DeployStatusSnapshot {
  deployUrl?: string;
  state: DeployState;
  source: string;
}

export interface DeployProvider {
  readonly platform: DeployPlatform;
  createProject(name: string, gitRepo?: { repo: string; type: "github" }): Promise<DeployProject>;
  setEnvironmentVariables(projectName: string, vars: Record<string, string | undefined>): Promise<void>;
  createDeployment(args: {
    projectName: string;
    gitSource: {
      repoId?: number;
      repo?: string;
      ref: string;
      type: "github";
    };
  }): Promise<DeployInstance>;
  waitForDeployment(
    deploymentId: string,
    options?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<DeployInstance>;
  cleanupOldDeployments(args: {
    projectId: string;
    keepDeploymentIds: string[];
    limit?: number;
  }): Promise<{ deleted: number; failed: number }>;
  disableDeploymentProtection(projectId: string): Promise<void>;
  deleteProject(projectName: string): Promise<"deleted" | "not_found">;
  getProjectDeploymentStatus(projectName: string): Promise<DeployStatusSnapshot>;
}
