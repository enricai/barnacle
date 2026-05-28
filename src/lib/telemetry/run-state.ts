/**
 * In-process singleton for surfacing the current NDJSON run-file and boot-time
 * orphan-recovery count on /readyz. Written by whoever opens the active run
 * file (the full event-stream subsystem when present; defaulting to null/0 in
 * deployments that have not yet wired it). Read-only accessors are exported so
 * health.ts stays decoupled from how the state is set.
 */

export interface RunState {
  /** Absolute path of the currently open .barnacle/events/*.ndjson file, or null when idle. */
  currentRunFile: string | null;
  /** Uncompressed byte count of the current run file, or 0 when idle. */
  currentRunFileSizeBytes: number;
  /** Number of orphaned NDJSON files recovered at last boot. */
  orphansRecovered: number;
}

let state: RunState = {
  currentRunFile: null,
  currentRunFileSizeBytes: 0,
  orphansRecovered: 0,
};

/** Returns a snapshot of the current telemetry run state. */
export function getTelemetryState(): RunState {
  return { ...state };
}

/** Merges partial overrides into the run state. Intended for boot wiring and tests. */
export function setTelemetryState(partial: Partial<RunState>): void {
  state = { ...state, ...partial };
}

/** Resets state to defaults. For tests only. */
export function resetTelemetryState(): void {
  state = { currentRunFile: null, currentRunFileSizeBytes: 0, orphansRecovered: 0 };
}
