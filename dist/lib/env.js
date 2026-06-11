"use strict";
/**
 * Environment variable readers for the config singleton. Kept deliberately
 * small — only the parsers config.ts actually calls. Richer env helpers
 * live in `@/config` where they can be typed against AppConfig.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNodeEnv = getNodeEnv;
exports.getEnv = getEnv;
exports.getBoolEnv = getBoolEnv;
exports.getNumericEnv = getNumericEnv;
exports.getFloatEnv = getFloatEnv;
/**
 * Returns the current NODE_ENV constrained to our three supported values,
 * defaulting to "development" for anything unrecognized.
 */
function getNodeEnv() {
    const env = process.env.NODE_ENV;
    if (env === "production" || env === "test") {
        return env;
    }
    return "development";
}
/**
 * Reads a string env var with a default. We DON'T trim / lowercase here —
 * callers decide the semantics so shapes like comma-separated lists can be
 * split before whitespace matters.
 */
function getEnv(key, defaultValue) {
    return process.env[key] || defaultValue;
}
/**
 * Parses boolean env vars permissively: "true", "1", "yes" (case-insensitive)
 * are truthy. Anything else (including "false", "0", "no") falls back to
 * the default — unset string → defaultValue.
 */
function getBoolEnv(key, defaultValue = false) {
    const value = process.env[key];
    if (!value) {
        return defaultValue;
    }
    return ["true", "1", "yes"].includes(value.toLowerCase());
}
/**
 * Parses numeric env vars. Non-numeric input falls back to `defaultValue`
 * instead of throwing — configuration should degrade gracefully, not crash
 * the process, on typos.
 */
function getNumericEnv(key, defaultValue) {
    const value = process.env[key];
    if (!value) {
        return defaultValue;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? defaultValue : parsed;
}
/**
 * Parses fractional env vars (e.g. LLM sampling temperature, confidence
 * thresholds). Non-numeric input falls back to `defaultValue` so a typo
 * never crashes the process.
 */
function getFloatEnv(key, defaultValue) {
    const value = process.env[key];
    if (!value) {
        return defaultValue;
    }
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? defaultValue : parsed;
}
//# sourceMappingURL=env.js.map