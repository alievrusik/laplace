import { Agent, Cursor } from "@cursor/sdk";
import { loadConfig } from "./config/env.js";

async function main() {
  const config = loadConfig();
  console.log(`Cursor model: ${config.cursor.model}`);

  console.log("Cursor.me starting");
  const me = await withTimeout(Cursor.me({ apiKey: config.cursor.apiKey }), 30000, "Cursor.me timed out");
  console.log(`Cursor.me ok: ${me.userEmail ?? me.apiKeyName}`);

  console.log("Cursor.models.list starting");
  const models = await withTimeout(
    Cursor.models.list({ apiKey: config.cursor.apiKey }),
    30000,
    "Cursor.models.list timed out",
  );
  console.log(`Cursor.models.list ok: ${models.map((model) => model.id).slice(0, 20).join(", ")}`);

  console.log("Agent.create starting");
  const agent = await withTimeout(
    Agent.create({
      apiKey: config.cursor.apiKey,
      model: { id: config.cursor.model },
      local: { cwd: process.cwd() },
    }),
    30000,
    "Agent.create timed out",
  );
  console.log("Agent.create ok");
  await agent[Symbol.asyncDispose]();
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
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
