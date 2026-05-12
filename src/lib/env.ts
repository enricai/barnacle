/**
 * Environment detection and configuration utilities.
 * Provides type-safe access to environment variables and environment checks.
 */

/**
 * Valid Node.js environment values.
 */
export type NodeEnv = "development" | "production" | "test";

/**
 * Gets the current NODE_ENV value.
 *
 * @returns The current environment ("development", "production", or "test")
 */
export function getNodeEnv(): NodeEnv {
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
export function isTestEnvironment(): boolean {
  return getNodeEnv() === "test";
}

/**
 * Checks if the current environment is production.
 *
 * @returns True if NODE_ENV is "production"
 */
export function isProductionEnvironment(): boolean {
  return getNodeEnv() === "production";
}

/**
 * Checks if the current environment is development.
 *
 * @returns True if NODE_ENV is "development" or not set
 */
export function isDevelopmentEnvironment(): boolean {
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
export function schedulePeriodicCleanup(
  callback: () => void,
  intervalMs: number
): NodeJS.Timeout | undefined {
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
export function getRequiredEnv(key: string): string {
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
export function getEnv(key: string, defaultValue: string): string {
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
export function getBoolEnv(key: string, defaultValue = false): boolean {
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
export function getNumericEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}
