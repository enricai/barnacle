export interface RunState {
    /** Absolute path of the currently open .barnacle/events/*.ndjson file, or null when idle. */
    currentRunFile: string | null;
    /** Uncompressed byte count of the current run file, or 0 when idle. */
    currentRunFileSizeBytes: number;
    /** Number of orphaned NDJSON files recovered at last boot. */
    orphansRecovered: number;
}
/** Exposes the current run state to health.ts without coupling it to the event-stream writer. */
export declare function getTelemetryState(): RunState;
/** Allows the event-stream subsystem (or tests) to update state without importing health.ts. */
export declare function setTelemetryState(partial: Partial<RunState>): void;
/** Restores initial defaults between test cases so state doesn't bleed across tests. */
export declare function resetTelemetryState(): void;
