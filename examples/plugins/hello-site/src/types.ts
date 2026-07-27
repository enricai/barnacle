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
 * Minimal local mirror of the `BeaconOutcomeInput` argument to
 * `context.recordBeaconOutcome` in Barnacle's `SitePluginContext`
 * (`src/site-plugin.ts`). Kept field-for-field in sync with the shipped
 * seam so a plugin copying this example sees the real call shape.
 */
export interface BeaconOutcomeInput {
  beaconStatus: "fired" | "failed";
  joinKeys: Record<string, unknown> | null;
  trackingUrl?: string | null;
  durationMs?: number;
}

/**
 * Minimal local mirror of Barnacle's `SitePluginContext`, narrowed to the
 * one seam a self-managing plugin needs: reporting a real `fired`/`failed`
 * outcome for a beacon it navigates itself. See the repository README's
 * Reconciliation join keys section for the full contract.
 */
export interface SitePluginContext {
  recordBeaconOutcome(input: BeaconOutcomeInput): Promise<void>;
}

/**
 * Minimal local mirror of Barnacle's `SitePlugin`. `executeHttp` is the
 * direct-HTTP hot path (no browser); `execute` is the browser fallback.
 */
export interface SitePlugin {
  meta: SitePluginMeta;
  executeHttp?(payload: unknown, context?: SitePluginContext): Promise<{ data: unknown }>;
  execute(
    payload: unknown,
    session?: unknown,
    context?: SitePluginContext
  ): Promise<{ data: unknown }>;
}
