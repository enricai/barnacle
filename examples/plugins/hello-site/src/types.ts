import type { ZodType } from "zod/v4";

/**
 * Minimal local mirror of Barnacle's `SitePluginMeta`. Kept in the example so
 * it builds with zero dependency on Barnacle's own `src/` (which is not
 * published as a type entry point in v1). In a real project, replace this file
 * with the Phase-2 `@barnacle/plugin-sdk` type import.
 */
export interface SitePluginMeta {
  siteId: string;
  displayName: string;
  bodySchema: ZodType;
  responseSchema: ZodType;
  /**
   * Plugin API version this module targets. Core matches the leading major
   * version against its own `PLUGIN_API_VERSION` (currently `1.0.0`). Use a
   * plain `"1.0.0"` — a caret range like `"^1.0.0"` is NOT parsed in v1 and
   * would disable the plugin. Omit to accept any version.
   */
  apiVersion?: string;
}

/**
 * Minimal local mirror of Barnacle's `SitePlugin`. `executeHttp` is the
 * direct-HTTP hot path (no browser); `execute` is the browser fallback.
 */
export interface SitePlugin {
  meta: SitePluginMeta;
  executeHttp?(payload: unknown, context?: unknown): Promise<{ data: unknown }>;
  execute(payload: unknown, session?: unknown, context?: unknown): Promise<{ data: unknown }>;
}
