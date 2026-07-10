import { getBoolEnv, getEnv, getFloatEnv, getNodeEnv, getNumericEnv } from "@/lib/env";

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
    /**
     * Default browser-session provider. Browserbase is the default because
     * Stagehand v3's payload-injection upload path is gated on
     * `env === "BROWSERBASE"` and several other code paths (CDP timeouts,
     * session recovery, event-window timing) only activate in that mode.
     * Steel remains a supported fallback via `SCRAPER_PROVIDER=steel` or the
     * `--provider steel` CLI flag.
     */
    provider: "browserbase" | "steel";
    browserbaseApiKey: string | undefined;
    browserbaseProjectId: string | undefined;
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
     * Per-site base URL overrides keyed by `meta.siteId`. Populated at startup
     * from `BARNACLE_SITE_<UPPERCASE_SITE_ID>_BASE_URL` env vars — underscores
     * in the env key map to hyphens in the siteId. Example:
     * `BARNACLE_SITE_MY_SHOP_BASE_URL=https://staging.my-shop.com` overrides
     * the `my-shop` plugin's `defaultBaseUrl` without any source change.
     * Falls back to `SitePluginMeta.defaultBaseUrl` when the key is absent.
     */
    siteBaseUrls: Record<string, string>;
    /** Master switch: routes Stagehand LLM calls through AWS Bedrock when true. */
    useBedrock: boolean;
    /** Anthropic SDK request timeout in ms. Raise for slow network paths to api.anthropic.com. */
    anthropicTimeoutMs: number;
    /** TCP connect timeout for all outbound fetch calls. Undici default is 10 s; raised to 120 s to match anthropicTimeoutMs. */
    connectTimeoutMs: number;
    /** Steel session wall-clock timeout in ms. Default is 1 hour; lower via STEEL_SESSION_TIMEOUT_MS on plans with shorter limits. */
    steelSessionTimeoutMs: number;
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
  telemetry: {
    /**
     * Master switch — set to false to disable all NDJSON telemetry writes.
     * Useful for environments where the disk path is unavailable or I/O is
     * cost-sensitive; the capture sink checks this before every append.
     */
    enabled: boolean;
    /**
     * Directory that holds per-run NDJSON event stream files. The event-writer
     * creates `<eventsDir>/<runId>.ndjson` at session start. Default matches
     * the `.barnacle/events` path referenced in run-state.ts so operator docs
     * and `.gitignore` stay consistent.
     */
    eventsDir: string;
    /**
     * Absolute or cwd-relative path for the append-only NDJSON file that
     * records one line per LLM/Stagehand call. Feed this to the judge and
     * self-heal skills. Default keeps it alongside the event-stream files.
     */
    callsNdjsonPath: string;
    /**
     * Absolute or cwd-relative path for the append-only NDJSON file that
     * records one line per dispatch outcome — the submission envelope. This
     * is the durable source-of-truth for "what did we submit for jobId X,
     * what did the site return, and did it succeed." Kept on a separate
     * sink from `callsNdjsonPath` so existing judge/heal readers (which
     * Zod-parse every line as an LlmCallSample) stay untouched.
     */
    submissionsNdjsonPath: string;
    /**
     * Rotate / drop the calls NDJSON once it exceeds this byte count.
     * Guards against unbounded disk growth on long-running deployments.
     * Default is 100 MB.
     */
    maxFileSizeBytes: number;
    /**
     * Drop event-stream files older than this many milliseconds. Default is
     * 30 days — long enough for a monthly judge/heal cadence.
     */
    maxRetentionMs: number;
    /**
     * Opt-in buffered S3 sink that mirrors local NDJSON telemetry so it
     * survives ECS container restarts. Entirely inert when `bucket` is
     * undefined — the sink checks this before buffering or flushing.
     */
    s3: {
      /** `TELEMETRY_S3_BUCKET` — destination bucket. Sink is a no-op when unset. */
      bucket: string | undefined;
      /** `TELEMETRY_S3_PREFIX` — key prefix for uploaded NDJSON objects. */
      prefix: string;
      /** `TELEMETRY_S3_FLUSH_INTERVAL_MS` — periodic flush interval. */
      flushIntervalMs: number;
      /** `TELEMETRY_S3_MAX_BUFFER_LINES` — threshold-flush trigger per buffer. */
      maxBufferLines: number;
    };
  };
  judging: {
    /**
     * Anthropic model used by the judge script to score captured call samples.
     * Defaults to the Bedrock cross-region inference profile so it reuses the
     * scraper's AWS creds without a separate billing account.
     */
    model: string;
    /**
     * Sampling temperature for judge LLM calls. Lower values (≤ 0.3) produce
     * more deterministic verdicts; raise only for exploratory runs.
     */
    temperature: number;
    /**
     * Number of call samples sent to the judge in one LLM request. Larger
     * batches reduce round-trips but increase per-call token cost.
     */
    batchSize: number;
    /**
     * Anthropic SDK request timeout for judge calls in ms. Judge batches are
     * larger than scraper calls so a longer timeout is warranted.
     */
    timeoutMs: number;
  };
  /**
   * testmail.app — fresh inboxes for recon runs + integration tests.
   * Both fields nullable so a missing API key doesn't break unrelated
   * config loads; the testmail helpers throw clear errors when called
   * without configuration.
   */
  testmail: {
    /** `TESTMAIL_API_KEY` — get from https://testmail.app/console */
    apiKey: string | undefined;
    /** `TESTMAIL_NAMESPACE` — the subdomain piece (e.g. "abc12" for `abc12.{tag}@inbox.testmail.app`). */
    namespace: string | undefined;
  };
  selfheal: {
    /**
     * Maximum patch→replay→score iterations before giving up with
     * BUDGET_EXHAUSTED. Mirrors the recon-heal default of 5.
     */
    maxIterations: number;
    /**
     * Number of replay runs per iteration arm. Replays are cheap (no browser),
     * so a higher n gives a more stable pass-rate estimate.
     */
    nReplays: number;
    /**
     * Minimum pass rate (0..1) to declare SUCCESS and stop iterating.
     * Mirrors the pila llm-self-heal SKILL default of 0.9.
     */
    successThreshold: number;
    /**
     * Consecutive iterations whose pass-rate improvement is below
     * `plateauDelta` that triggers a PLATEAUED verdict. Mirrors recon-heal.
     */
    plateauWindow: number;
    /**
     * Minimum absolute improvement in pass rate between iterations to be
     * considered meaningful progress; below this the run plateaus.
     */
    plateauDelta: number;
    /**
     * Per-replay LLM request timeout in ms. Patch replay calls are small
     * single-turn requests so a tighter timeout keeps the loop fast.
     */
    timeoutMs: number;
  };
  datadog: {
    /** Master switch — dd-trace only initializes when true. */
    traceEnabled: boolean;
    /** Hostname of the DD agent sidecar (localhost in ECS Fargate). */
    agentHost: string;
    /** DogStatsD UDP port on the agent host. */
    statsdPort: number;
    /** Service name emitted on all spans, metrics, and logs. */
    service: string;
    /** Deployment environment tag (production, staging, development). */
    env: string;
    /** Application version tag — git SHA or package version. */
    version: string;
  };
  /**
   * Out-of-tree plugin loading. Operators point `BARNACLE_PLUGINS` at their
   * own compiled plugin modules; core discovers, validates, and registers them
   * at startup without any source change.
   */
  plugins: {
    /**
     * Comma-separated list of plugin specifiers — relative paths
     * (`./plugins/acme`) or package names (`@acme/barnacle-plugin`).
     * Parsed from `BARNACLE_PLUGINS`; empty by default (built-ins only).
     */
    specifiers: readonly string[];
    /**
     * When true, any plugin that fails to load aborts the process.
     * When false (default), failures produce a disabled record and a warn log.
     */
    strict: boolean;
    /**
     * Base directory used to resolve relative plugin specifiers and to locate
     * the operator's `node_modules` for package-name specifiers. Defaults to
     * `process.cwd()` so paths are relative to wherever the operator runs the
     * binary — NOT the installed Barnacle package root.
     */
    baseDir: string;
    /**
     * Optional directory scanned at startup for `*.plugin.json` manifests, each
     * loaded as a config-only plugin. Lets operators register sites by dropping
     * a file in a directory instead of editing `BARNACLE_PLUGINS`. Parsed from
     * `BARNACLE_PLUGINS_CONFIG_DIR`; unset means no directory scan.
     */
    configDir: string | undefined;
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
  return {
    appName: getEnv("APP_NAME", "barnacle"),
    nodeEnv: getNodeEnv(),
    host: getEnv("HOST", "0.0.0.0"),
    port: getNumericEnv("PORT", 3000),
    logLevel: getEnv("LOG_LEVEL", "info"),
    auth: {
      hashedKeys: parseList(getEnv("API_KEYS_HASHED", "")),
      devBypass: getBoolEnv("DEV_BYPASS_AUTH", false),
    },
    trustProxy: getBoolEnv("TRUST_PROXY", true),
    scraper: {
      provider: (() => {
        const raw = (getEnv("SCRAPER_PROVIDER", "browserbase") || "").toLowerCase();
        if (raw !== "browserbase" && raw !== "steel") {
          throw new Error(
            `SCRAPER_PROVIDER must be "browserbase" or "steel" (got ${JSON.stringify(raw)})`
          );
        }
        return raw;
      })(),
      browserbaseApiKey: process.env.BROWSERBASE_API_KEY,
      browserbaseProjectId: process.env.BROWSERBASE_PROJECT_ID,
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
      siteBaseUrls: (() => {
        const map: Record<string, string> = {};
        for (const [key, val] of Object.entries(process.env)) {
          const match = /^BARNACLE_SITE_([A-Z0-9_]+)_BASE_URL$/.exec(key);
          if (match && val) {
            map[match[1]?.toLowerCase().replace(/_/g, "-") ?? ""] = val;
          }
        }
        return map;
      })(),
      useBedrock: getBoolEnv("USE_BEDROCK", false),
      anthropicTimeoutMs: getNumericEnv("STAGEHAND_API_TIMEOUT_MS", 120_000),
      connectTimeoutMs: getNumericEnv("STAGEHAND_CONNECT_TIMEOUT_MS", 120_000),
      steelSessionTimeoutMs: getNumericEnv("STEEL_SESSION_TIMEOUT_MS", 3_600_000),
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
    telemetry: {
      enabled: getBoolEnv("TELEMETRY_ENABLED", true),
      eventsDir: getEnv("TELEMETRY_EVENTS_DIR", ".barnacle/events"),
      callsNdjsonPath: getEnv("CALLS_NDJSON_PATH", ".barnacle/calls.ndjson"),
      submissionsNdjsonPath: getEnv("SUBMISSIONS_NDJSON_PATH", ".barnacle/submissions.ndjson"),
      maxFileSizeBytes: getNumericEnv("TELEMETRY_MAX_FILE_SIZE_BYTES", 100 * 1024 * 1024),
      maxRetentionMs: getNumericEnv("TELEMETRY_MAX_RETENTION_MS", 30 * 24 * 60 * 60 * 1000),
      s3: {
        bucket: process.env.TELEMETRY_S3_BUCKET || undefined,
        prefix: getEnv("TELEMETRY_S3_PREFIX", "telemetry"),
        flushIntervalMs: getNumericEnv("TELEMETRY_S3_FLUSH_INTERVAL_MS", 60_000),
        maxBufferLines: getNumericEnv("TELEMETRY_S3_MAX_BUFFER_LINES", 500),
      },
    },
    judging: {
      model: getEnv("JUDGE_MODEL", "us.anthropic.claude-sonnet-4-6[1m]"),
      temperature: getFloatEnv("JUDGE_TEMPERATURE", 0.2),
      batchSize: getNumericEnv("JUDGE_BATCH_SIZE", 10),
      timeoutMs: getNumericEnv("JUDGE_TIMEOUT_MS", 120_000),
    },
    testmail: {
      apiKey: process.env.TESTMAIL_API_KEY,
      namespace: process.env.TESTMAIL_NAMESPACE,
    },
    selfheal: {
      maxIterations: getNumericEnv("SELFHEAL_MAX_ITERATIONS", 5),
      nReplays: getNumericEnv("SELFHEAL_N_REPLAYS", 5),
      successThreshold: getFloatEnv("SELFHEAL_SUCCESS_THRESHOLD", 0.9),
      plateauWindow: getNumericEnv("SELFHEAL_PLATEAU_WINDOW", 3),
      plateauDelta: getFloatEnv("SELFHEAL_PLATEAU_DELTA", 0.03),
      timeoutMs: getNumericEnv("SELFHEAL_TIMEOUT_MS", 60_000),
    },
    datadog: {
      traceEnabled: getBoolEnv("DD_TRACE_ENABLED", false),
      agentHost: getEnv("DD_AGENT_HOST", "localhost"),
      statsdPort: getNumericEnv("DD_DOGSTATSD_PORT", 8125),
      service: getEnv("DD_SERVICE", "barnacle"),
      env: getEnv("DD_ENV", getNodeEnv()),
      version: getEnv("DD_VERSION", "0.1.0"),
    },
    plugins: {
      specifiers: parseList(getEnv("BARNACLE_PLUGINS", "")),
      strict: getBoolEnv("BARNACLE_PLUGINS_STRICT", false),
      baseDir: getEnv("BARNACLE_PLUGINS_DIR", process.cwd()),
      configDir: process.env.BARNACLE_PLUGINS_CONFIG_DIR || undefined,
    },
  };
}

export const config: AppConfig = loadConfig();
