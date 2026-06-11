/**
 * In-process counters for the spec's drift-detection signals (spec §6B).
 * Exposed via /readyz so ops dashboards can alert when fallback rate rises —
 * a rising fallback rate means the hot-path contract has drifted and recon
 * needs re-running.
 */
/** Per-site drift-detection counters exposed on /readyz and used by ops dashboards. */
export interface SiteMetrics {
    hotPathSuccess: number;
    fallbackActivations: number;
    rateLimitRejections: number;
    /** p95 hot-path round-trip latency in ms over the last ~1000 samples. undefined until first sample. */
    p95LatencyMs: number | undefined;
}
/**
 * Records a successful direct-HTTP hot-path response for `siteId`. Called by
 * dispatch() when `executeHttp()` resolves without error.
 */
export declare function recordHotPathSuccess(siteId: string): void;
/**
 * Records a fallback activation for `siteId`. Called by dispatch() when the
 * hot path throws `HttpSchemaError`, `HttpBotChallengeError`, or `HttpServerError`
 * and the Stagehand browser path is engaged instead.
 */
export declare function recordFallbackActivation(siteId: string): void;
/**
 * Records a rate-limit rejection for `siteId`. Called by dispatch() when the
 * hot path throws `HttpRateLimitError` (429 from the target). A rising count
 * signals the configured rps ceiling needs to be lowered.
 */
export declare function recordRateLimitRejection(siteId: string): void;
/**
 * Records a hot-path round-trip latency sample and updates the p95 percentile.
 * Reservoir is capped at RESERVOIR_SIZE to bound memory; once full, a random
 * slot is replaced (Vitter's Algorithm R). Called by dispatch() on non-cached
 * hot-path successes only — cache hits are memory reads and must not bias the
 * upstream latency signal.
 */
export declare function recordHotPathLatency(siteId: string, latencyMs: number): void;
/**
 * Returns a snapshot of all per-site counters. Safe to expose on /readyz —
 * values are monotonically increasing integers since process start.
 */
export declare function allMetrics(): Record<string, SiteMetrics>;
/**
 * Resets all counters. Intended for use in tests only — never call in
 * production as it discards drift-detection history.
 */
export declare function resetMetrics(): void;
