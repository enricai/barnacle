"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
exports.loadConfig = loadConfig;
const env_1 = require("./lib/env");
/**
 * Parses a comma-separated env var into a non-empty string array with the
 * empty entries filtered out. Returns an empty array if the var is unset.
 */
function parseList(value) {
    return value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}
/**
 * Loads and validates the application config. Call this once at process
 * startup; subsequent calls return the same frozen object.
 */
function loadConfig() {
    return {
        appName: (0, env_1.getEnv)("APP_NAME", "barnacle"),
        nodeEnv: (0, env_1.getNodeEnv)(),
        host: (0, env_1.getEnv)("HOST", "0.0.0.0"),
        port: (0, env_1.getNumericEnv)("PORT", 3000),
        logLevel: (0, env_1.getEnv)("LOG_LEVEL", "info"),
        databaseUrl: process.env.DATABASE_URL,
        auth: {
            hashedKeys: parseList((0, env_1.getEnv)("API_KEYS_HASHED", "")),
            devBypass: (0, env_1.getBoolEnv)("DEV_BYPASS_AUTH", false),
        },
        trustProxy: (0, env_1.getBoolEnv)("TRUST_PROXY", true),
        scraper: {
            provider: (() => {
                const raw = ((0, env_1.getEnv)("SCRAPER_PROVIDER", "browserbase") || "").toLowerCase();
                if (raw !== "browserbase" && raw !== "steel") {
                    throw new Error(`SCRAPER_PROVIDER must be "browserbase" or "steel" (got ${JSON.stringify(raw)})`);
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
            model: (0, env_1.getEnv)("STAGEHAND_MODEL", "anthropic/claude-sonnet-4-6"),
            proxyType: (0, env_1.getEnv)("SCRAPER_PROXY_TYPE", "residential"),
            solveCaptcha: (0, env_1.getBoolEnv)("SCRAPER_SOLVE_CAPTCHA", true),
            poolSize: (0, env_1.getNumericEnv)("SESSION_POOL_SIZE", 3),
            minActionDelayMs: (0, env_1.getNumericEnv)("SCRAPER_MIN_ACTION_DELAY_MS", 500),
            maxActionDelayMs: (0, env_1.getNumericEnv)("SCRAPER_MAX_ACTION_DELAY_MS", 1500),
            readinessQueueThreshold: (0, env_1.getNumericEnv)("READINESS_QUEUE_THRESHOLD", 20),
            siteBaseUrls: (() => {
                const map = {};
                for (const [key, val] of Object.entries(process.env)) {
                    const match = /^BARNACLE_SITE_([A-Z0-9_]+)_BASE_URL$/.exec(key);
                    if (match && val) {
                        map[match[1]?.toLowerCase().replace(/_/g, "-") ?? ""] = val;
                    }
                }
                return map;
            })(),
            useBedrock: (0, env_1.getBoolEnv)("USE_BEDROCK", false),
            anthropicTimeoutMs: (0, env_1.getNumericEnv)("STAGEHAND_API_TIMEOUT_MS", 120_000),
            connectTimeoutMs: (0, env_1.getNumericEnv)("STAGEHAND_CONNECT_TIMEOUT_MS", 120_000),
            steelSessionTimeoutMs: (0, env_1.getNumericEnv)("STEEL_SESSION_TIMEOUT_MS", 3_600_000),
        },
        bedrock: {
            region: (0, env_1.getEnv)("AWS_REGION", "us-east-1"),
            accessKeyId: process.env.AWS_ACCESS_KEY_ID || undefined,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || undefined,
            sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
            model: (0, env_1.getEnv)("BEDROCK_MODEL", "us.anthropic.claude-sonnet-4-6[1m]"),
        },
        cache: {
            ttlMs: (0, env_1.getNumericEnv)("CACHE_TTL_MS", 15 * 60 * 1000),
            maxEntries: (0, env_1.getNumericEnv)("CACHE_MAX_ENTRIES", 1000),
        },
        rateLimit: {
            max: (0, env_1.getNumericEnv)("RATE_LIMIT_MAX", 120),
            windowMs: (0, env_1.getNumericEnv)("RATE_LIMIT_WINDOW_MS", 60_000),
        },
        docs: {
            enabled: (0, env_1.getBoolEnv)("ENABLE_DOCS", false),
        },
        telemetry: {
            enabled: (0, env_1.getBoolEnv)("TELEMETRY_ENABLED", true),
            eventsDir: (0, env_1.getEnv)("TELEMETRY_EVENTS_DIR", ".barnacle/events"),
            callsNdjsonPath: (0, env_1.getEnv)("CALLS_NDJSON_PATH", ".barnacle/calls.ndjson"),
            maxFileSizeBytes: (0, env_1.getNumericEnv)("TELEMETRY_MAX_FILE_SIZE_BYTES", 100 * 1024 * 1024),
            maxRetentionMs: (0, env_1.getNumericEnv)("TELEMETRY_MAX_RETENTION_MS", 30 * 24 * 60 * 60 * 1000),
        },
        judging: {
            model: (0, env_1.getEnv)("JUDGE_MODEL", "us.anthropic.claude-sonnet-4-6[1m]"),
            temperature: (0, env_1.getFloatEnv)("JUDGE_TEMPERATURE", 0.2),
            batchSize: (0, env_1.getNumericEnv)("JUDGE_BATCH_SIZE", 10),
            timeoutMs: (0, env_1.getNumericEnv)("JUDGE_TIMEOUT_MS", 120_000),
        },
        testmail: {
            apiKey: process.env.TESTMAIL_API_KEY,
            namespace: process.env.TESTMAIL_NAMESPACE,
        },
        selfheal: {
            maxIterations: (0, env_1.getNumericEnv)("SELFHEAL_MAX_ITERATIONS", 5),
            nReplays: (0, env_1.getNumericEnv)("SELFHEAL_N_REPLAYS", 5),
            successThreshold: (0, env_1.getFloatEnv)("SELFHEAL_SUCCESS_THRESHOLD", 0.9),
            plateauWindow: (0, env_1.getNumericEnv)("SELFHEAL_PLATEAU_WINDOW", 3),
            plateauDelta: (0, env_1.getFloatEnv)("SELFHEAL_PLATEAU_DELTA", 0.03),
            timeoutMs: (0, env_1.getNumericEnv)("SELFHEAL_TIMEOUT_MS", 60_000),
        },
    };
}
exports.config = loadConfig();
//# sourceMappingURL=config.js.map