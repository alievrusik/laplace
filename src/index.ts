import { BudgetGuard } from "./budget/guard.js";
import { ProjectBuilder } from "./builder/projectBuilder.js";
import { loadConfig } from "./config/env.js";
import { createDeployProvider } from "./deploy/factory.js";
import { DeploymentTelemetry } from "./deploy/telemetry.js";
import { JobRunner } from "./jobs/runner.js";
import { GigaChatFoundation } from "./llm/gigachat.js";
import { LaplaceLlm } from "./llm/laplaceLlm.js";
import { MemoryCatalog } from "./memory/catalog.js";
import { ConversationOrchestrator } from "./orchestrator/conversationOrchestrator.js";
import { GitSync } from "./provision/gitSync.js";
import { ProjectProvisioner } from "./provision/github.js";
import { ResourceEstimator } from "./resource/estimator.js";
import { TelegramBot } from "./telegram/bot.js";
import { MiniAppServer } from "./telegram/miniAppServer.js";
import {
  FileCache,
  IdeaValidator,
  PrototypeValidator,
  TavilyClient,
} from "./validator/index.js";

async function main() {
  const config = loadConfig();
  const llm = new LaplaceLlm(config.laplaceLlm);
  const gigachat = new GigaChatFoundation({
    ...config.demoFoundation.gigachat,
    rawEnv: config.demoFoundation.gigachat.raw,
  });
  const memory = new MemoryCatalog(config.paths.memoryDir, llm);
  const deploy = createDeployProvider(config);
  const deploymentTelemetry = new DeploymentTelemetry({
    deploy,
    mcpEnabled: config.deploy.mcpEnabled,
  });
  const orchestrator = new ConversationOrchestrator({
    llm,
    cursorApiKey: config.cursor.apiKey,
    runtimeCwd: process.cwd(),
    briefModel: config.cursor.briefModel,
    skepticModel: config.cursor.skepticModel,
    memoryDir: config.paths.memoryDir,
    surveyPath: "GenAI_Client_Survey_Final.xlsx",
  });
  const jobs = new JobRunner();
  let ideaValidator: IdeaValidator | undefined;
  let prototypeValidator: PrototypeValidator | undefined;
  if (config.validator.enabled) {
    const validatorLlm = new LaplaceLlm(config.validator.llm);
    const validatorCache = new FileCache(
      config.validator.cacheDir,
      undefined,
      config.validator.cacheDisabled,
    );
    const tavily = new TavilyClient({
      apiKey: config.validator.tavilyApiKey,
      cache: validatorCache,
    });
    ideaValidator = new IdeaValidator({
      laplaceLlm: validatorLlm,
      tavilyApiKey: config.validator.tavilyApiKey,
      cacheDir: config.validator.cacheDir,
      cacheDisabled: config.validator.cacheDisabled,
      enableAdvanced: true,
    });
    prototypeValidator = new PrototypeValidator({
      laplaceLlm: validatorLlm,
      tavily,
    });
    console.log(
      `[validator] enabled (model=${config.validator.llm.model}, baseURL=${config.validator.llm.baseURL}, tavily=${Boolean(config.validator.tavilyApiKey)}, empirical=${Boolean(config.validator.tavilyApiKey)})`,
    );
  }

  const bot = new TelegramBot({
    config,
    llm,
    memory,
    orchestrator,
    estimator: new ResourceEstimator({
      llm,
      workspaceDir: config.paths.workspaceDir,
      memoryDir: config.paths.memoryDir,
      cursorApiKey: config.cursor.apiKey,
      runtimeCwd: process.cwd(),
      modelId: config.cursor.estimatorModel,
    }),
    budget: new BudgetGuard(),
    jobs,
    provisioner: new ProjectProvisioner({
      token: config.github.token,
      owner: config.github.owner,
      visibility: config.github.visibility,
      workspaceDir: config.paths.workspaceDir,
    }),
    gitSync: new GitSync(),
    builder: new ProjectBuilder(config.cursor),
    deploy,
    deploymentTelemetry,
    gigachat,
    ideaValidator,
    prototypeValidator,
  });
  const miniApp = new MiniAppServer({
    bot,
    port: config.telegram.miniApp.port,
    baseUrl: config.telegram.miniApp.baseUrl,
  });

  process.once("SIGINT", () => {
    void miniApp.stop();
    bot.stop("SIGINT");
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    void miniApp.stop();
    bot.stop("SIGTERM");
    process.exit(0);
  });

  await miniApp.start();
  await bot.launch();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
