/**
 * Run-scoped, mutable telemetry accumulator that a plugin can write
 * discovered fields into at any point during execute()/executeHttp() —
 * parallels `MetricsCollector` (src/lib/dispatch-metrics.ts) as a per-request
 * instance meant to be threaded through the plugin context, but for
 * run-discovered data (join keys, session info) rather than step timings.
 * Funnels everything a plugin discovers mid-run into the same opaque
 * `joinKeys` bag already documented in `reconciliation-record.ts`, rather
 * than inventing a second bag.
 */

/** Browserbase session identity/network facts recorded once per run. */
export interface SessionTelemetry {
  sessionId: string;
  provider: string;
  ip: string | null;
  ipCapturedAt: string | null;
}

/** The identity of a throw caught on the hot submit path, recorded once per run. */
export interface HotPathErrorTelemetry {
  name: string;
  message: string;
  code: string | null;
}

/** Point-in-time view of everything accumulated on a `RunTelemetry` instance. */
export interface RunTelemetrySnapshot {
  joinKeys: Record<string, unknown> | null;
  session: SessionTelemetry | null;
  hotPathError: HotPathErrorTelemetry | null;
}

/**
 * Public surface `SitePluginContext.telemetry` exposes to plugins. Declared
 * separately from the `RunTelemetry` class (rather than using the class
 * itself as the field type) so consumers — including this repo's own test
 * doubles — can satisfy the contract with a plain object; `RunTelemetry`'s
 * private accumulator fields would otherwise make it structurally
 * unsatisfiable by anything but the class itself.
 */
export interface RunTelemetryHandle {
  addJoinKeys(fields: Record<string, unknown>): void;
  recordSession(info: SessionTelemetry): void;
  recordHotPathError(error: HotPathErrorTelemetry): void;
  snapshot(): RunTelemetrySnapshot;
}

/**
 * Accumulates run-discovered join keys and session telemetry for a single
 * dispatch invocation. Constructed per-request in `buildPluginContext`
 * (`src/plugins/loader.ts`) and threaded through `SitePluginContext.telemetry`
 * so a plugin can attach fields it only learns mid-run — a token minted
 * mid-flow, a value read from the page after navigation — instead of being
 * limited to `extractJoinKeys`'s inbound-payload-only view.
 */
export class RunTelemetry implements RunTelemetryHandle {
  private joinKeys: Record<string, unknown> | null = null;
  private session: SessionTelemetry | null = null;
  private hotPathError: HotPathErrorTelemetry | null = null;

  /**
   * Merges `fields` into the accumulated join-key bag. Later calls win on
   * key collision, so a plugin can refine an early guess as the run
   * progresses without losing earlier keys it doesn't repeat.
   */
  addJoinKeys(fields: Record<string, unknown>): void {
    this.joinKeys = { ...this.joinKeys, ...fields };
  }

  /**
   * Records Browserbase session identity/network facts. Last-write-wins
   * (whole-object replace) since a run has at most one active session at a
   * time — unlike join keys, there's no reason to merge partial calls.
   */
  recordSession(info: SessionTelemetry): void {
    this.session = info;
  }

  /**
   * Records the throw caught on the hot submit path. Last-write-wins
   * (whole-object replace) since a run has at most one hot-path throw,
   * matching the same reasoning as `recordSession`.
   */
  recordHotPathError(error: HotPathErrorTelemetry): void {
    this.hotPathError = error;
  }

  /**
   * Returns a defensive copy of everything accumulated so far. `joinKeys`
   * stays `null` (not `{}`) when nothing was ever added, so dispatch can
   * keep emitting `joinKeys: null` unchanged until a plugin actually writes
   * to this collector.
   */
  snapshot(): RunTelemetrySnapshot {
    return {
      joinKeys: this.joinKeys ? { ...this.joinKeys } : null,
      session: this.session ? { ...this.session } : null,
      hotPathError: this.hotPathError ? { ...this.hotPathError } : null,
    };
  }
}
