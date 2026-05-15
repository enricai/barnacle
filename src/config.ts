import { getBoolEnv, getEnv, getNodeEnv, getNumericEnv } from "@/lib/env";

/**
 * Fully resolved, strongly typed application config derived from environment
 * variables at process start. Consumers import the `config` singleton instead
 * of reading `process.env` directly so that required vars are validated once.
 */
export interface AppConfig {
  appName: string;
  nodeEnv: "development" | "production" | "test";
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string | undefined;
  auth: {
    hashedKeys: readonly string[];
    devBypass: boolean;
  };
  /**
   * Whether Fastify trusts inbound `X-Forwarded-For` / `X-Forwarded-Proto`.
   * True is correct when Barnacle runs behind a reverse proxy (ALB, nginx,
   * Cloudflare). False is required when deployed directly to the internet
   * — otherwise clients can spoof `X-Forwarded-For` to bypass rate
   * limiting, since the rate-limit key falls back to `request.ip` for
   * unauthenticated traffic.
   */
  trustProxy: boolean;
  scraper: {
    steelApiKey: string | undefined;
    anthropicApiKey: string | undefined;
    model: string;
    proxyType: string;
    solveCaptcha: boolean;
    poolSize: number;
    minActionDelayMs: number;
    maxActionDelayMs: number;
    readinessQueueThreshold: number;
    /**
     * Per-site base URLs keyed by siteId. The `fema` key is compile-time
     * anchored so the existing FEMA flow keeps strict typing; the index
     * signature keeps the map open for new sites without editing config.ts.
     */
    siteBaseUrls: { fema: string; [key: string]: string };
    /** Master switch: routes Stagehand LLM calls through AWS Bedrock when true. */
    useBedrock: boolean;
  };
  bedrock: {
    region: string;
    accessKeyId: string | undefined;
    secretAccessKey: string | undefined;
    sessionToken: string | undefined;
    model: string;
  };
  cache: {
    ttlMs: number;
    maxEntries: number;
  };
  rateLimit: {
    max: number;
    windowMs: number;
  };
  docs: {
    enabled: boolean;
  };
}

/**
 * Parses a comma-separated env var into a non-empty string array with the
 * empty entries filtered out. Returns an empty array if the var is unset.
 */
function parseList(value: string): readonly string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Loads and validates the application config. Call this once at process
 * startup; subsequent calls return the same frozen object.
 */
export function loadConfig(): AppConfig {
  return Object.freeze<AppConfig>({
    appName: getEnv("APP_NAME", "barnacle"),
    nodeEnv: getNodeEnv(),
    host: getEnv("HOST", "0.0.0.0"),
    port: getNumericEnv("PORT", 3000),
    logLevel: getEnv("LOG_LEVEL", "info"),
    databaseUrl: process.env.DATABASE_URL,
    auth: {
      hashedKeys: parseList(getEnv("API_KEYS_HASHED", "")),
      devBypass: getBoolEnv("DEV_BYPASS_AUTH", false),
    },
    trustProxy: getBoolEnv("TRUST_PROXY", true),
    scraper: {
      steelApiKey: process.env.STEEL_API_KEY,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      // Stagehand 2.x's modelToProviderMap is stale (knows only up to
      // claude-3-7-sonnet). Using the provider-prefixed form
      // `anthropic/<model-id>` routes through the AI-SDK fallback
      // path which forwards the name verbatim to the Anthropic SDK,
      // letting us use live model ids like claude-sonnet-4-6.
      model: getEnv("STAGEHAND_MODEL", "anthropic/claude-sonnet-4-6"),
      proxyType: getEnv("SCRAPER_PROXY_TYPE", "residential"),
      solveCaptcha: getBoolEnv("SCRAPER_SOLVE_CAPTCHA", true),
      poolSize: getNumericEnv("SESSION_POOL_SIZE", 3),
      minActionDelayMs: getNumericEnv("SCRAPER_MIN_ACTION_DELAY_MS", 500),
      maxActionDelayMs: getNumericEnv("SCRAPER_MAX_ACTION_DELAY_MS", 1500),
      readinessQueueThreshold: getNumericEnv("READINESS_QUEUE_THRESHOLD", 20),
      siteBaseUrls: { fema: getEnv("FEMA_BASE_URL", "https://disasterassistance.gov") },
      useBedrock: getBoolEnv("USE_BEDROCK", false),
    },
    bedrock: {
      region: getEnv("AWS_REGION", "us-east-1"),
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || undefined,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || undefined,
      sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
      model: getEnv("BEDROCK_MODEL", "us.anthropic.claude-sonnet-4-6[1m]"),
    },
    cache: {
      ttlMs: getNumericEnv("CACHE_TTL_MS", 15 * 60 * 1000),
      maxEntries: getNumericEnv("CACHE_MAX_ENTRIES", 1000),
    },
    rateLimit: {
      max: getNumericEnv("RATE_LIMIT_MAX", 120),
      windowMs: getNumericEnv("RATE_LIMIT_WINDOW_MS", 60_000),
    },
    docs: {
      enabled: getBoolEnv("ENABLE_DOCS", false),
    },
  });
}

export const config: AppConfig = loadConfig();
