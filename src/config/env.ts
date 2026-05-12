import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

const foundationProviders = ["anthropic", "vllm", "sam3"] as const;

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ADMIN_USER_IDS: z.string().min(1),
  PROXY: optionalUrl,
  PROXY_CA_CERT_PATH: optionalString,
  TELEGRAM_PROXY_URL: optionalUrl,
  TELEGRAM_PROXY_CA_CERT_PATH: optionalString,

  LAPLACE_LLM_BASE_URL: z.string().url(),
  LAPLACE_LLM_API_KEY: z.string().min(1),
  LAPLACE_LLM_MODEL: z.string().default("Qwen/Qwen3.5-397B-A17B-FP8"),
  LAPLACE_LLM_DISABLE_REASONING: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  CURSOR_API_KEY: z.string().min(1),
  CURSOR_BUILDER_MODEL: z.string().default("composer-2-fast"),

  GITHUB_TOKEN: z.string().min(1),
  GITHUB_OWNER: z.string().min(1),
  GITHUB_REPOS_VISIBILITY: z.enum(["private", "public"]).default("private"),

  VERCEL_TOKEN: z.string().min(1),
  VERCEL_TEAM_ID: z.string().optional(),

  DEMO_FOUNDATION_PROVIDER: z.enum(foundationProviders).default("anthropic"),
  DEMO_FOUNDATION_PROVIDERS: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  ANTHROPIC_PROXY_URL: optionalUrl,
  ANTHROPIC_PROXY_CA_CERT_PATH: optionalString,
  ANTHROPIC_PROXY_CA_CERT_BASE64: optionalString,
  VERCEL_USE_ANTHROPIC_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  DEMO_VLLM_BASE_URL: optionalUrl,
  DEMO_VLLM_API_KEY: optionalString,
  DEMO_VLLM_MODEL: optionalString,
  SAM3_API_KEY: optionalString,
  SAM3_API_BASE_URL: z.string().url().default("https://api.segmind.com/v1"),

  LAPLACE_WORKSPACE_DIR: z.string().default("./laplace-workspace"),
  LAPLACE_MEMORY_DIR: z.string().default("./laplace-memory"),
  LAPLACE_DEFAULT_PROFILE: z.enum(["admin", "client"]).default("admin"),
  LAPLACE_REQUIRE_CONFIRMATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid Laplace environment:\n${missing}`);
  }

  const env = parsed.data;
  const availableFoundationProviders = resolveAvailableFoundationProviders({
    configuredProviders: env.DEMO_FOUNDATION_PROVIDERS,
    fallbackProvider: env.DEMO_FOUNDATION_PROVIDER,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    vllmApiKey: env.DEMO_VLLM_API_KEY,
    vllmBaseURL: env.DEMO_VLLM_BASE_URL,
    vllmModel: env.DEMO_VLLM_MODEL,
    sam3ApiKey: env.SAM3_API_KEY,
  });

  return {
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN,
      adminUserIds: new Set(
        env.TELEGRAM_ADMIN_USER_IDS.split(",")
          .map((id) => Number(id.trim()))
          .filter(Number.isFinite),
      ),
      proxyUrl: env.TELEGRAM_PROXY_URL ?? env.PROXY,
      proxyCaCertPath: env.TELEGRAM_PROXY_CA_CERT_PATH ?? env.PROXY_CA_CERT_PATH
        ? path.resolve((env.TELEGRAM_PROXY_CA_CERT_PATH ?? env.PROXY_CA_CERT_PATH)!)
        : undefined,
    },
    laplaceLlm: {
      baseURL: env.LAPLACE_LLM_BASE_URL,
      apiKey: env.LAPLACE_LLM_API_KEY,
      model: env.LAPLACE_LLM_MODEL,
      disableReasoning: env.LAPLACE_LLM_DISABLE_REASONING,
    },
    cursor: {
      apiKey: env.CURSOR_API_KEY,
      model: env.CURSOR_BUILDER_MODEL,
    },
    github: {
      token: env.GITHUB_TOKEN,
      owner: env.GITHUB_OWNER,
      visibility: env.GITHUB_REPOS_VISIBILITY,
    },
    vercel: {
      token: env.VERCEL_TOKEN,
      teamId: env.VERCEL_TEAM_ID,
    },
    demoFoundation: {
      provider: env.DEMO_FOUNDATION_PROVIDER,
      availableProviders: availableFoundationProviders,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      anthropicModel: env.ANTHROPIC_MODEL,
      anthropicProxyUrl: env.ANTHROPIC_PROXY_URL ?? env.TELEGRAM_PROXY_URL ?? env.PROXY,
      anthropicProxyCaCertPath: env.ANTHROPIC_PROXY_CA_CERT_PATH ?? env.TELEGRAM_PROXY_CA_CERT_PATH ?? env.PROXY_CA_CERT_PATH
        ? path.resolve(
            (env.ANTHROPIC_PROXY_CA_CERT_PATH ??
              env.TELEGRAM_PROXY_CA_CERT_PATH ??
              env.PROXY_CA_CERT_PATH)!,
          )
        : undefined,
      anthropicProxyCaCertBase64: env.ANTHROPIC_PROXY_CA_CERT_BASE64,
      vercelUseAnthropicProxy: env.VERCEL_USE_ANTHROPIC_PROXY,
      vllmBaseURL: env.DEMO_VLLM_BASE_URL,
      vllmApiKey: env.DEMO_VLLM_API_KEY,
      vllmModel: env.DEMO_VLLM_MODEL,
      sam3ApiKey: env.SAM3_API_KEY,
      sam3ApiBaseURL: env.SAM3_API_BASE_URL,
    },
    paths: {
      workspaceDir: path.resolve(env.LAPLACE_WORKSPACE_DIR),
      memoryDir: path.resolve(env.LAPLACE_MEMORY_DIR),
    },
    defaults: {
      profile: env.LAPLACE_DEFAULT_PROFILE,
      requireConfirmation: env.LAPLACE_REQUIRE_CONFIRMATION,
    },
  };
}

function resolveAvailableFoundationProviders(args: {
  configuredProviders?: string;
  fallbackProvider: (typeof foundationProviders)[number];
  anthropicApiKey?: string;
  vllmApiKey?: string;
  vllmBaseURL?: string;
  vllmModel?: string;
  sam3ApiKey?: string;
}): Array<(typeof foundationProviders)[number]> {
  const configured = args.configuredProviders
    ?.split(",")
    .map((provider) => provider.trim())
    .filter((provider): provider is (typeof foundationProviders)[number] =>
      foundationProviders.includes(provider as (typeof foundationProviders)[number]),
    );

  if (configured?.length) return unique(configured);

  const inferred: Array<(typeof foundationProviders)[number]> = [];
  if (args.anthropicApiKey) inferred.push("anthropic");
  if (args.vllmBaseURL && args.vllmApiKey && args.vllmModel) inferred.push("vllm");
  if (args.sam3ApiKey) inferred.push("sam3");

  return unique(inferred.length ? inferred : [args.fallbackProvider]);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
