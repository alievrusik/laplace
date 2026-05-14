import type { AppConfig } from "../config/env.js";
import type { DeployProvider } from "./provider.js";
import { RenderDeployManager } from "./render.js";
import { DeployManager } from "./vercel.js";

export function createDeployProvider(config: AppConfig): DeployProvider {
  if (config.deploy.provider === "render") {
    if (!config.deploy.render.apiKey) {
      throw new Error("RENDER_API_KEY is required when DEPLOY_PROVIDER=render");
    }
    return new RenderDeployManager({
      apiKey: config.deploy.render.apiKey,
      ownerId: config.deploy.render.ownerId,
      subprojectName: config.deploy.render.subprojectName,
      mcpEnabled: config.deploy.render.mcpEnabled,
    });
  }

  if (!config.vercel.token) {
    throw new Error("VERCEL_TOKEN is required when DEPLOY_PROVIDER=vercel");
  }
  return new DeployManager({
    token: config.vercel.token,
    teamId: config.vercel.teamId,
  });
}
