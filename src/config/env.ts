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

const optionalBoolean = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
);

const optionalPositiveInt = z.preprocess(
  (value) => {
    if (value === "" || value === undefined) return undefined;
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number(value);
    return value;
  },
  z.number().int().positive().optional(),
);

const foundationProviders = ["anthropic", "vllm", "sam3", "gigachat"] as const;

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ADMIN_USER_IDS: z.string().min(1),
  PROXY: optionalUrl,
  PROXY_CA_CERT_PATH: optionalString,
  TELEGRAM_PROXY_URL: optionalUrl,
  TELEGRAM_PROXY_CA_CERT_PATH: optionalString,
  TELEGRAM_MINIAPP_BASE_URL: optionalUrl,
  PORT: optionalPositiveInt,
  TELEGRAM_MINIAPP_PORT: z.coerce.number().int().positive().default(4310),

  LAPLACE_LLM_BASE_URL: z.string().url(),
  LAPLACE_LLM_API_KEY: z.string().min(1),
  LAPLACE_LLM_MODEL: z.string().default("Qwen/Qwen3.5-397B-A17B-FP8"),
  LAPLACE_LLM_DISABLE_REASONING: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  CURSOR_API_KEY: z.string().min(1),
  CURSOR_BUILDER_MODEL: z.string().default("composer-2"),
  CURSOR_TESTER_MODEL: z.string().default("composer-2"),
  CURSOR_BRIEF_MODEL: optionalString,
  CURSOR_SKEPTIC_MODEL: optionalString,
  CURSOR_ESTIMATOR_MODEL: optionalString,
  CURSOR_REVISOR_MODEL: optionalString,
  CURSOR_RUNTIME_REASONING: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  GITHUB_TOKEN: z.string().min(1),
  GITHUB_OWNER: z.string().min(1),
  GITHUB_REPOS_VISIBILITY: z.enum(["private", "public"]).default("private"),

  DEPLOY_PROVIDER: z.enum(["render", "vercel"]).default("render"),
  VERCEL_TOKEN: optionalString,
  VERCEL_TEAM_ID: z.string().optional(),
  VERCEL_MCP_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  RENDER_API_KEY: optionalString,
  RENDER_OWNER_ID: optionalString,
  RENDER_PROJECT_NAME: optionalString,
  RENDER_SUBPROJECT_NAME: optionalString,
  RENDER_MCP_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  TAVILY_API_KEY: optionalString,
  VALIDATOR_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  VALIDATOR_USE_ANTHROPIC: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  VALIDATOR_CACHE_DIR: optionalString,
  VALIDATOR_CACHE_DISABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  VALIDATOR_AUTO_PRE_VALIDATE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  VALIDATOR_AUTO_POST_AUDIT: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  DEMO_FOUNDATION_PROVIDER: z.enum(foundationProviders).default("anthropic"),
  DEMO_FOUNDATION_PROVIDERS: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  ANTHROPIC_PROXY_URL: optionalUrl,
  ANTHROPIC_PROXY_CA_CERT_PATH: optionalString,
  ANTHROPIC_PROXY_CA_CERT_BASE64: optionalString,
  DEPLOY_USE_ANTHROPIC_PROXY: optionalBoolean,
  VERCEL_USE_ANTHROPIC_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  DEMO_VLLM_BASE_URL: optionalUrl,
  DEMO_VLLM_API_KEY: optionalString,
  DEMO_VLLM_MODEL: optionalString,
  SAM3_API_KEY: optionalString,
  SAM3_API_BASE_URL: z.string().url().default("https://api.segmind.com/v1"),
  GIGACHAT_BASE_URL: optionalUrl,
  GIGACHAT_AUTH_URL: optionalUrl,
  GIGACHAT_SCOPE: optionalString,
  GIGACHAT_MODEL: optionalString,
  GIGACHAT_EMBEDDINGS_MODEL: optionalString,
  GIGACHAT_STT_MODEL: optionalString,
  GIGACHAT_VERIFY_SSL_CERTS: optionalBoolean,
  GIGACHAT_CLIENT_ID: optionalString,
  GIGACHAT_CLIENT_SECRET: optionalString,
  GIGACHAT_ACCESS_TOKEN: optionalString,

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
  const miniAppPort = env.PORT ?? env.TELEGRAM_MINIAPP_PORT;
  const deployUseAnthropicProxy = env.DEPLOY_USE_ANTHROPIC_PROXY ?? env.VERCEL_USE_ANTHROPIC_PROXY;
  const cursorBriefModel = env.CURSOR_BRIEF_MODEL ?? env.CURSOR_BUILDER_MODEL;
  const cursorSkepticModel = env.CURSOR_SKEPTIC_MODEL ?? cursorBriefModel;
  const cursorEstimatorModel = env.CURSOR_ESTIMATOR_MODEL ?? cursorSkepticModel;
  const cursorRevisorModel = env.CURSOR_REVISOR_MODEL ?? env.CURSOR_TESTER_MODEL;
  const availableFoundationProviders = resolveAvailableFoundationProviders({
    configuredProviders: env.DEMO_FOUNDATION_PROVIDERS,
    fallbackProvider: env.DEMO_FOUNDATION_PROVIDER,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    vllmApiKey: env.DEMO_VLLM_API_KEY,
    vllmBaseURL: env.DEMO_VLLM_BASE_URL,
    vllmModel: env.DEMO_VLLM_MODEL,
    sam3ApiKey: env.SAM3_API_KEY,
    gigachatBaseURL: env.GIGACHAT_BASE_URL,
    gigachatAuthURL: env.GIGACHAT_AUTH_URL,
    gigachatAccessToken: env.GIGACHAT_ACCESS_TOKEN,
    gigachatClientId: env.GIGACHAT_CLIENT_ID,
    gigachatClientSecret: env.GIGACHAT_CLIENT_SECRET,
  });

  if (env.DEPLOY_PROVIDER === "render" && !env.RENDER_API_KEY) {
    throw new Error("Invalid Laplace environment:\nRENDER_API_KEY: required when DEPLOY_PROVIDER=render");
  }
  if (env.DEPLOY_PROVIDER === "vercel" && !env.VERCEL_TOKEN) {
    throw new Error("Invalid Laplace environment:\nVERCEL_TOKEN: required when DEPLOY_PROVIDER=vercel");
  }

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
      miniApp: {
        baseUrl: env.TELEGRAM_MINIAPP_BASE_URL,
        port: miniAppPort,
      },
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
      builderModel: env.CURSOR_BUILDER_MODEL,
      evaluatorModel: env.CURSOR_TESTER_MODEL,
      testerModel: env.CURSOR_TESTER_MODEL,
      briefModel: cursorBriefModel,
      skepticModel: cursorSkepticModel,
      estimatorModel: cursorEstimatorModel,
      revisorModel: cursorRevisorModel,
      reasoningEnabled: env.CURSOR_RUNTIME_REASONING,
    },
    github: {
      token: env.GITHUB_TOKEN,
      owner: env.GITHUB_OWNER,
      visibility: env.GITHUB_REPOS_VISIBILITY,
    },
    deploy: {
      provider: env.DEPLOY_PROVIDER,
      mcpEnabled: env.DEPLOY_PROVIDER === "render" ? env.RENDER_MCP_ENABLED : env.VERCEL_MCP_ENABLED,
      vercel: {
        token: env.VERCEL_TOKEN,
        teamId: env.VERCEL_TEAM_ID,
        mcpEnabled: env.VERCEL_MCP_ENABLED,
      },
      render: {
        apiKey: env.RENDER_API_KEY,
        ownerId: env.RENDER_OWNER_ID,
        projectName: env.RENDER_PROJECT_NAME ?? "Laplace-prod",
        subprojectName: env.RENDER_SUBPROJECT_NAME ?? "Laplace-subprojects",
        mcpEnabled: env.RENDER_MCP_ENABLED,
      },
    },
    validator: {
      enabled: env.VALIDATOR_ENABLED,
      useAnthropic: env.VALIDATOR_USE_ANTHROPIC,
      tavilyApiKey: env.TAVILY_API_KEY,
      cacheDir: env.VALIDATOR_CACHE_DIR ?? path.resolve(process.cwd(), "laplace-cache", "validator"),
      cacheDisabled: env.VALIDATOR_CACHE_DISABLED,
      autoPreValidate: env.VALIDATOR_AUTO_PRE_VALIDATE,
      autoPostAudit: env.VALIDATOR_AUTO_POST_AUDIT,
    },
    // Legacy snapshot retained for compatibility in remaining modules.
    vercel: {
      token: env.VERCEL_TOKEN,
      teamId: env.VERCEL_TEAM_ID,
      mcpEnabled: env.VERCEL_MCP_ENABLED,
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
      deployUseAnthropicProxy,
      vercelUseAnthropicProxy: env.VERCEL_USE_ANTHROPIC_PROXY,
      vllmBaseURL: env.DEMO_VLLM_BASE_URL,
      vllmApiKey: env.DEMO_VLLM_API_KEY,
      vllmModel: env.DEMO_VLLM_MODEL,
      sam3ApiKey: env.SAM3_API_KEY,
      sam3ApiBaseURL: env.SAM3_API_BASE_URL,
      gigachat: {
        baseURL: env.GIGACHAT_BASE_URL,
        authURL: env.GIGACHAT_AUTH_URL,
        scope: env.GIGACHAT_SCOPE,
        model: env.GIGACHAT_MODEL,
        embeddingsModel: env.GIGACHAT_EMBEDDINGS_MODEL,
        sttModel: env.GIGACHAT_STT_MODEL,
        verifySslCerts: env.GIGACHAT_VERIFY_SSL_CERTS ?? true,
        clientId: env.GIGACHAT_CLIENT_ID,
        clientSecret: env.GIGACHAT_CLIENT_SECRET,
        accessToken: env.GIGACHAT_ACCESS_TOKEN,
        raw: collectPrefixedEnv("GIGACHAT_"),
      },
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

function collectPrefixedEnv(prefix: string): Record<string, string> {
  const entries = Object.entries(process.env).filter(
    ([key, value]) => key.startsWith(prefix) && typeof value === "string",
  );
  return Object.fromEntries(entries as Array<[string, string]>);
}

function resolveAvailableFoundationProviders(args: {
  configuredProviders?: string;
  fallbackProvider: (typeof foundationProviders)[number];
  anthropicApiKey?: string;
  vllmApiKey?: string;
  vllmBaseURL?: string;
  vllmModel?: string;
  sam3ApiKey?: string;
  gigachatBaseURL?: string;
  gigachatAuthURL?: string;
  gigachatAccessToken?: string;
  gigachatClientId?: string;
  gigachatClientSecret?: string;
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
  if (args.gigachatBaseURL && (args.gigachatAccessToken || (args.gigachatAuthURL && args.gigachatClientId && args.gigachatClientSecret))) {
    inferred.push("gigachat");
  }

  return unique(inferred.length ? inferred : [args.fallbackProvider]);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
