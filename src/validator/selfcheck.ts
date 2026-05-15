import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { LaplaceLlm } from "../llm/laplaceLlm.js";
import { runModelPolicyCheck } from "../testing/modelPolicyCheck.js";
import { FileCache } from "./cache.js";
import { TavilyClient } from "./grounding/tavily.js";
import { IdeaValidator } from "./orchestrator.js";

async function main() {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const llm = new LaplaceLlm({
    baseURL: process.env.LAPLACE_LLM_BASE_URL!,
    apiKey: process.env.LAPLACE_LLM_API_KEY!,
    model: process.env.LAPLACE_LLM_MODEL!,
    disableReasoning: true,
  });
  const cache = new FileCache(path.resolve("./laplace-cache/validator/selfcheck"), undefined, true);
  const tavily = new TavilyClient({ apiKey: process.env.TAVILY_API_KEY, cache });
  checks.push({ name: "TAVILY_API_KEY", ok: Boolean(process.env.TAVILY_API_KEY), detail: process.env.TAVILY_API_KEY ? "set" : "missing" });
  checks.push({
    name: "VALIDATOR_LLM_MODEL",
    ok: Boolean(process.env.VALIDATOR_LLM_MODEL ?? process.env.LAPLACE_LLM_MODEL),
    detail: process.env.VALIDATOR_LLM_MODEL ?? process.env.LAPLACE_LLM_MODEL ?? "missing",
  });
  try {
    runModelPolicyCheck();
    checks.push({ name: "Model role mapping", ok: true, detail: "builder/tester/revisor mapping intact" });
  } catch (error) {
    checks.push({ name: "Model role mapping", ok: false, detail: String(error) });
  }
  try {
    const llmSource = await fs.readFile(new URL("../llm/laplaceLlm.ts", import.meta.url), "utf8");
    checks.push({
      name: "Temperature-free LLM payload",
      ok: !/temperature\s*:/.test(llmSource),
      detail: /temperature\s*:/.test(llmSource) ? "temperature key found" : "no temperature key",
    });
  } catch (error) {
    checks.push({ name: "Temperature-free LLM payload", ok: false, detail: String(error) });
  }

  try {
    const ping = await llm.complete([
      { role: "system", content: "Reply with pong" },
      { role: "user", content: "ping" },
    ]);
    checks.push({ name: "Laplace LLM ping", ok: /pong/i.test(ping), detail: ping.slice(0, 60) });
  } catch (error) {
    checks.push({ name: "Laplace LLM ping", ok: false, detail: String(error) });
  }

  if (tavily.isEnabled()) {
    const hits = await tavily.search("AI startup validation", 2).catch(() => []);
    checks.push({ name: "Tavily search", ok: hits.length > 0, detail: `hits=${hits.length}` });
  }

  try {
    const validator = new IdeaValidator({
      laplaceLlm: llm,
      tavilyApiKey: process.env.TAVILY_API_KEY,
      cacheDir: path.resolve("./laplace-cache/validator/selfcheck"),
      cacheDisabled: true,
      enableAdvanced: false,
    });
    const report = await validator.validate({
      rawPrompt: "AI assistant for cooking recipes",
      conversationContext: [],
    });
    checks.push({
      name: "IdeaValidator synthetic run",
      ok: report.criticReports.length > 0,
      detail: `verdict=${report.verdict} score=${report.overallScore}`,
    });
  } catch (error) {
    checks.push({ name: "IdeaValidator synthetic run", ok: false, detail: String(error) });
  }

  console.log("\n=== Validator selfcheck ===\n");
  for (const check of checks) {
    console.log(`[${check.ok ? "OK  " : "WARN"}] ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
  }
  const failed = checks.filter((item) => !item.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
