"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordHotPathSuccess = recordHotPathSuccess;
exports.recordFallbackActivation = recordFallbackActivation;
exports.recordRateLimitRejection = recordRateLimitRejection;
exports.recordHotPathLatency = recordHotPathLatency;
exports.allMetrics = allMetrics;
exports.resetMetrics = resetMetrics;
const random_1 = require("../lib/random");
const store = new Map();
const RESERVOIR_SIZE = 1000;
const latencyStore = new Map();
function ensureEntry(siteId) {
    const existing = store.get(siteId);
    if (existing)
        return existing;
    const entry = {
        hotPathSuccess: 0,
        fallbackActivations: 0,
        rateLimitRejections: 0,
        p95LatencyMs: undefined,
    };
    store.set(siteId, entry);
    latencyStore.set(siteId, []);
    return entry;
}
/**
 * Records a successful direct-HTTP hot-path response for `siteId`. Called by
 * dispatch() when `executeHttp()` resolves without error.
 */
function recordHotPathSuccess(siteId) {
    ensureEntry(siteId).hotPathSuccess++;
}
/**
 * Records a fallback activation for `siteId`. Called by dispatch() when the
 * hot path throws `HttpSchemaError`, `HttpBotChallengeError`, or `HttpServerError`
 * and the Stagehand browser path is engaged instead.
 */
function recordFallbackActivation(siteId) {
    ensureEntry(siteId).fallbackActivations++;
}
/**
 * Records a rate-limit rejection for `siteId`. Called by dispatch() when the
 * hot path throws `HttpRateLimitError` (429 from the target). A rising count
 * signals the configured rps ceiling needs to be lowered.
 */
function recordRateLimitRejection(siteId) {
    ensureEntry(siteId).rateLimitRejections++;
}
/**
 * Records a hot-path round-trip latency sample and updates the p95 percentile.
 * Reservoir is capped at RESERVOIR_SIZE to bound memory; once full, a random
 * slot is replaced (Vitter's Algorithm R). Called by dispatch() on non-cached
 * hot-path successes only — cache hits are memory reads and must not bias the
 * upstream latency signal.
 */
function recordHotPathLatency(siteId, latencyMs) {
    const entry = ensureEntry(siteId);
    // biome-ignore lint/style/noNonNullAssertion: ensureEntry() always sets this key
    const reservoir = latencyStore.get(siteId);
    if (reservoir.length < RESERVOIR_SIZE) {
        reservoir.push(latencyMs);
    }
    else {
        reservoir[(0, random_1.randomIntInclusive)(0, RESERVOIR_SIZE - 1)] = latencyMs;
    }
    const sorted = [...reservoir].sort((a, b) => a - b);
    entry.p95LatencyMs = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
}
/**
 * Returns a snapshot of all per-site counters. Safe to expose on /readyz —
 * values are monotonically increasing integers since process start.
 */
function allMetrics() {
    return Object.fromEntries(store.entries());
}
/**
 * Resets all counters. Intended for use in tests only — never call in
 * production as it discards drift-detection history.
 */
function resetMetrics() {
    store.clear();
    latencyStore.clear();
}
//# sourceMappingURL=metrics.js.map