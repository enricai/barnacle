/**
 * Run-scoped, mutable telemetry accumulator that a plugin can write
 * discovered fields into at any point during execute()/executeHttp() —
 * mirrors `MetricsCollector` (src/lib/dispatch-metrics.ts) as a per-request
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

/** Point-in-time view of everything accumulated on a `RunTelemetry` instance. */
export interface RunTelemetrySnapshot {
  joinKeys: Record<string, unknown> | null;
  session: SessionTelemetry | null;
}

/**
 * Accumulates run-discovered join keys and session telemetry for a single
 * dispatch invocation. Constructed per-request and threaded through
 * SitePluginContext (wiring lands separately) so a plugin can attach fields
 * it only learns mid-run — a token minted mid-flow, a value read from the
 * page after navigation — instead of being limited to `extractJoinKeys`'s
 * inbound-payload-only view.
 */
export class RunTelemetry {
  private joinKeys: Record<string, unknown> | null = null;
  private session: SessionTelemetry | null = null;

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
   * Returns a defensive copy of everything accumulated so far. `joinKeys`
   * stays `null` (not `{}`) when nothing was ever added, so dispatch can
   * keep emitting `joinKeys: null` unchanged until a plugin actually writes
   * to this collector.
   */
  snapshot(): RunTelemetrySnapshot {
    return {
      joinKeys: this.joinKeys ? { ...this.joinKeys } : null,
      session: this.session ? { ...this.session } : null,
    };
  }
}
