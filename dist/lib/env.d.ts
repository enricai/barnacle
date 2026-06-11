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
export declare function getNodeEnv(): NodeEnv;
/**
 * Reads a string env var with a default. We DON'T trim / lowercase here —
 * callers decide the semantics so shapes like comma-separated lists can be
 * split before whitespace matters.
 */
export declare function getEnv(key: string, defaultValue: string): string;
/**
 * Parses boolean env vars permissively: "true", "1", "yes" (case-insensitive)
 * are truthy. Anything else (including "false", "0", "no") falls back to
 * the default — unset string → defaultValue.
 */
export declare function getBoolEnv(key: string, defaultValue?: boolean): boolean;
/**
 * Parses numeric env vars. Non-numeric input falls back to `defaultValue`
 * instead of throwing — configuration should degrade gracefully, not crash
 * the process, on typos.
 */
export declare function getNumericEnv(key: string, defaultValue: number): number;
/**
 * Parses fractional env vars (e.g. LLM sampling temperature, confidence
 * thresholds). Non-numeric input falls back to `defaultValue` so a typo
 * never crashes the process.
 */
export declare function getFloatEnv(key: string, defaultValue: number): number;
export {};
