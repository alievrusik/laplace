import fs from "node:fs/promises";
import { Telegraf } from "telegraf";
import { loadConfig } from "./config/env.js";
import { createTelegramAgent } from "./telegram/proxy.js";

async function main() {
  const config = loadConfig();

  console.log("Laplace doctor");
  console.log(`Telegram proxy: ${config.telegram.proxyUrl ? "configured" : "not configured"}`);
  console.log(
    `Telegram proxy CA: ${config.telegram.proxyCaCertPath ? config.telegram.proxyCaCertPath : "not configured"}`,
  );
  console.log(`Anthropic proxy: ${config.demoFoundation.anthropicProxyUrl ? "configured" : "not configured"}`);
  console.log(
    `Anthropic proxy CA: ${
      config.demoFoundation.anthropicProxyCaCertPath ? config.demoFoundation.anthropicProxyCaCertPath : "not configured"
    }`,
  );
  console.log(`Laplace LLM: ${config.laplaceLlm.baseURL} / ${config.laplaceLlm.model}`);
  console.log(`Cursor builder model: ${config.cursor.model}`);
  console.log(`GitHub owner: ${config.github.owner}`);
  console.log(`Demo foundation provider: ${config.demoFoundation.provider}`);
  console.log(`Available foundation providers: ${config.demoFoundation.availableProviders.join(", ")}`);
  console.log(`SAM3 API: ${config.demoFoundation.sam3ApiKey ? "configured" : "not configured"}`);
  console.log(`SAM3 base URL: ${config.demoFoundation.sam3ApiBaseURL}`);

  if (config.telegram.proxyCaCertPath) {
    await fs.access(config.telegram.proxyCaCertPath);
    console.log("Telegram proxy CA file: readable");
  }

  if (config.demoFoundation.anthropicProxyCaCertPath) {
    await fs.access(config.demoFoundation.anthropicProxyCaCertPath);
    console.log("Anthropic proxy CA file: readable");
  }

  const agent = createTelegramAgent({
    proxyUrl: config.telegram.proxyUrl,
    proxyCaCertPath: config.telegram.proxyCaCertPath,
  });

  const bot = new Telegraf(config.telegram.botToken, {
    telegram: agent ? { agent } : undefined,
  });

  const me = await withTimeout(bot.telegram.getMe(), 15000, "Telegram getMe timed out");
  console.log(`Telegram bot: @${me.username ?? me.first_name}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
