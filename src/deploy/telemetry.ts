import type { DeployProvider } from "./provider.js";

export interface DeploymentTelemetrySnapshot {
  deployUrl?: string;
  state: "unknown" | "building" | "ready" | "error";
  source: string;
}

export class DeploymentTelemetry {
  constructor(
    private readonly deps: {
      deploy: DeployProvider;
      mcpEnabled: boolean;
    },
  ) {}

  async getProjectSnapshot(projectSlug: string): Promise<DeploymentTelemetrySnapshot> {
    if (this.deps.mcpEnabled) {
      try {
        const mcpSnapshot = await this.fetchViaMcp(projectSlug);
        if (mcpSnapshot) return mcpSnapshot;
      } catch (error) {
        console.warn(`[${this.deps.deploy.platform}-mcp] fallback to API for ${projectSlug}:`, error);
      }
    }

    const apiSnapshot = await this.deps.deploy.getProjectDeploymentStatus(projectSlug);
    return {
      deployUrl: apiSnapshot.deployUrl,
      state: apiSnapshot.state,
      source: apiSnapshot.source,
    };
  }

  private async fetchViaMcp(_projectSlug: string): Promise<DeploymentTelemetrySnapshot | undefined> {
    // Placeholder: runtime keeps a graceful fallback because MCP availability/auth can vary by environment.
    // When concrete render/vercel MCP client bindings are available in runtime, wire them here.
    return undefined;
  }
}
