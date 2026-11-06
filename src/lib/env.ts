/**
 * Environment variable readers for the config singleton. Kept deliberately
 * small — only the parsers config.ts actually calls. Richer env helpers
 * live in `@/config` where they can be typed against AppConfig.
 */

type NodeEnv = "development" | "production" | "test";

/**
 * Returns the current NODE_ENV constrained to our three supported values,
 * defaulting to "development" for anything unrecognized.
 */
export function getNodeEnv(): NodeEnv {
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
export function getEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/**
 * Parses boolean env vars permissively: "true", "1", "yes" (case-insensitive)
 * are truthy. Anything else (including "false", "0", "no") falls back to
 * the default — unset string → defaultValue.
 */
export function getBoolEnv(key: string, defaultValue = false): boolean {
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
export function getNumericEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parses numeric env vars that must be strictly positive, such as a size
 * ceiling or a pool width.
 *
 * Why separate from {@link getNumericEnv}: some consumers treat a
 * non-positive value as a hard error rather than "no limit". `lru-cache`, for
 * instance, throws from its *constructor* when given `maxSize: 0` or a
 * negative — and that constructor runs at module load, so a single mistyped
 * env var takes the whole process down at startup instead of degrading. This
 * keeps the "configuration degrades, it does not crash" contract the rest of
 * this module follows.
 *
 * Zero, negatives, fractions and non-numeric input all fall back to
 * `defaultValue`. Deliberately does NOT log: `@/lib/logging` imports this
 * module, so logging here would be a circular import. Callers that want to
 * surface a rejected value should compare against the default themselves.
 *
 * Parses the raw string itself rather than delegating to
 * {@link getNumericEnv}: that helper uses `parseInt`, which truncates "1.5"
 * to 1 — so a fractional byte ceiling would silently become a 1-byte one
 * instead of being rejected.
 */
export function getPositiveNumericEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

/**
 * Parses fractional env vars (e.g. LLM sampling temperature, confidence
 * thresholds). Non-numeric input falls back to `defaultValue` so a typo
 * never crashes the process.
 */
export function getFloatEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) {
    return defaultValue;
  }
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}
