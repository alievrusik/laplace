import { BudgetGuard } from "./budget/guard.js";
import { ProjectBuilder } from "./builder/projectBuilder.js";
import { loadConfig } from "./config/env.js";
import { DeployManager } from "./deploy/vercel.js";
import { JobRunner } from "./jobs/runner.js";
import { LaplaceLlm } from "./llm/laplaceLlm.js";
import { MemoryCatalog } from "./memory/catalog.js";
import { GitSync } from "./provision/gitSync.js";
import { ProjectProvisioner } from "./provision/github.js";
import { ResourceEstimator } from "./resource/estimator.js";
import { TelegramBot } from "./telegram/bot.js";

async function main() {
  const config = loadConfig();
  const llm = new LaplaceLlm(config.laplaceLlm);
  const memory = new MemoryCatalog(config.paths.memoryDir, llm);
  const jobs = new JobRunner();

  const bot = new TelegramBot({
    config,
    llm,
    memory,
    estimator: new ResourceEstimator({
      llm,
      workspaceDir: config.paths.workspaceDir,
      memoryDir: config.paths.memoryDir,
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
    deploy: new DeployManager(config.vercel),
  });

  process.once("SIGINT", () => {
    bot.stop("SIGINT");
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    bot.stop("SIGTERM");
    process.exit(0);
  });

  await bot.launch();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
