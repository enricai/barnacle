"use strict";
/**
 * Environment detection and configuration utilities.
 * Provides type-safe access to environment variables and environment checks.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNodeEnv = getNodeEnv;
exports.isTestEnvironment = isTestEnvironment;
exports.isProductionEnvironment = isProductionEnvironment;
exports.isDevelopmentEnvironment = isDevelopmentEnvironment;
exports.schedulePeriodicCleanup = schedulePeriodicCleanup;
exports.getRequiredEnv = getRequiredEnv;
exports.getEnv = getEnv;
exports.getBoolEnv = getBoolEnv;
exports.getNumericEnv = getNumericEnv;
/**
 * Gets the current NODE_ENV value.
 *
 * @returns The current environment ("development", "production", or "test")
 */
function getNodeEnv() {
    const env = process.env.NODE_ENV;
    if (env === "production" || env === "test") {
        return env;
    }
    return "development";
}
/**
 * Checks if the current environment is test.
 * Use this to disable timers, logging, or other side effects in tests.
 *
 * @returns True if NODE_ENV is "test"
 * @example
 * ```typescript
 * if (!isTestEnvironment()) {
 *   setInterval(cleanupJob, 60000);
 * }
 * ```
 */
function isTestEnvironment() {
    return getNodeEnv() === "test";
}
/**
 * Checks if the current environment is production.
 *
 * @returns True if NODE_ENV is "production"
 */
function isProductionEnvironment() {
    return getNodeEnv() === "production";
}
/**
 * Checks if the current environment is development.
 *
 * @returns True if NODE_ENV is "development" or not set
 */
function isDevelopmentEnvironment() {
    return getNodeEnv() === "development";
}
/**
 * Schedules a periodic cleanup job that is skipped in test environments.
 * Prevents open handle warnings in Jest/Vitest.
 *
 * @param callback - The cleanup function to run
 * @param intervalMs - Interval in milliseconds
 * @returns The interval ID (or undefined in test environment)
 * @example
 * ```typescript
 * schedulePeriodicCleanup(() => {
 *   cleanupExpiredTokens();
 * }, 60000);
 * ```
 */
function schedulePeriodicCleanup(callback, intervalMs) {
    if (isTestEnvironment()) {
        return undefined;
    }
    return setInterval(callback, intervalMs);
}
/**
 * Gets an environment variable or throws if not set.
 * Use this for required configuration values.
 *
 * @param key - The environment variable name
 * @returns The environment variable value
 * @throws Error if the variable is not set
 * @example
 * ```typescript
 * const databaseUrl = getRequiredEnv("DATABASE_URL");
 * ```
 */
function getRequiredEnv(key) {
    const value = process.env[key];
    if (!value) {
        throw new Error(`missing required environment variable: ${key}`);
    }
    return value;
}
/**
 * Gets an environment variable with a default value.
 *
 * @param key - The environment variable name
 * @param defaultValue - Default value if not set
 * @returns The environment variable value or default
 */
function getEnv(key, defaultValue) {
    return process.env[key] || defaultValue;
}
/**
 * Gets a boolean environment variable.
 * Treats "true", "1", "yes" as true (case-insensitive).
 *
 * @param key - The environment variable name
 * @param defaultValue - Default value if not set
 * @returns Boolean value
 */
function getBoolEnv(key, defaultValue = false) {
    const value = process.env[key];
    if (!value) {
        return defaultValue;
    }
    return ["true", "1", "yes"].includes(value.toLowerCase());
}
/**
 * Gets a numeric environment variable.
 *
 * @param key - The environment variable name
 * @param defaultValue - Default value if not set or invalid
 * @returns Numeric value
 */
function getNumericEnv(key, defaultValue) {
    const value = process.env[key];
    if (!value) {
        return defaultValue;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? defaultValue : parsed;
}
//# sourceMappingURL=env.js.map