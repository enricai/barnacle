import type { ZodType } from "zod/v4";

/**
 * Minimal local copy of Barnacle's `SitePluginMeta`. Kept in the example so
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
 * Minimal local copy of the `BeaconOutcomeInput` argument to
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
 * Minimal local copy of the `RunTelemetryHandle` argument to
 * `context.telemetry` in Barnacle's `SitePluginContext`
 * (`src/lib/telemetry/run-telemetry.ts`). Narrowed to the one method this
 * example's README documents: attaching a field only discovered mid-run.
 */
export interface RunTelemetryHandle {
  addJoinKeys(fields: Record<string, unknown>): void;
}

/**
 * Minimal local copy of Barnacle's `SitePluginContext`, narrowed to the
 * two seams a self-managing plugin needs: reporting a real `fired`/`failed`
 * outcome for a beacon it navigates itself, and attaching join keys it only
 * discovers mid-run. See the repository README's Reconciliation join keys
 * section for the full contract.
 */
export interface SitePluginContext {
  recordBeaconOutcome(input: BeaconOutcomeInput): Promise<void>;
  telemetry: RunTelemetryHandle;
}

/**
 * Minimal local copy of Barnacle's `SitePlugin`. `executeHttp` is the
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
