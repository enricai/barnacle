/**
 * Runtime version of the plugin API contract that core enforces at load time.
 * Kept separate from `site-plugin.ts` because that file is strictly type-only
 * and must have zero runtime side effects; a `const` value would break that
 * guarantee.
 */
export const PLUGIN_API_VERSION = "1.0.0" as const;
