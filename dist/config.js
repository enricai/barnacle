"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
exports.loadConfig = loadConfig;
const env_1 = require("@/lib/env");
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
    return Object.freeze({
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
        scraper: {
            steelApiKey: process.env.STEEL_API_KEY,
            anthropicApiKey: process.env.ANTHROPIC_API_KEY,
            model: (0, env_1.getEnv)("STAGEHAND_MODEL", "claude-sonnet-4-6"),
            proxyType: (0, env_1.getEnv)("SCRAPER_PROXY_TYPE", "residential"),
            poolSize: (0, env_1.getNumericEnv)("SESSION_POOL_SIZE", 3),
            minActionDelayMs: (0, env_1.getNumericEnv)("SCRAPER_MIN_ACTION_DELAY_MS", 500),
            maxActionDelayMs: (0, env_1.getNumericEnv)("SCRAPER_MAX_ACTION_DELAY_MS", 1500),
        },
        cache: {
            ttlMs: (0, env_1.getNumericEnv)("CACHE_TTL_MS", 15 * 60 * 1000),
            maxEntries: (0, env_1.getNumericEnv)("CACHE_MAX_ENTRIES", 1000),
        },
        rateLimit: {
            max: (0, env_1.getNumericEnv)("RATE_LIMIT_MAX", 120),
            windowMs: (0, env_1.getNumericEnv)("RATE_LIMIT_WINDOW_MS", 60_000),
        },
        workers: {
            enabled: (0, env_1.getBoolEnv)("ENABLE_WORKERS", false),
            refreshCron: (0, env_1.getEnv)("REFRESH_CRON", "0 3 * * *"),
            changesCron: (0, env_1.getEnv)("CHANGES_CRON", "0 * * * *"),
        },
        docs: {
            enabled: (0, env_1.getBoolEnv)("ENABLE_DOCS", false),
        },
    });
}
exports.config = loadConfig();
//# sourceMappingURL=config.js.map