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

const store = new Map<string, SiteMetrics>();

const RESERVOIR_SIZE = 1000;
const latencyStore = new Map<string, number[]>();

function ensureEntry(siteId: string): SiteMetrics {
  const existing = store.get(siteId);
  if (existing) return existing;
  const entry: SiteMetrics = {
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
export function recordHotPathSuccess(siteId: string): void {
  ensureEntry(siteId).hotPathSuccess++;
}

/**
 * Records a fallback activation for `siteId`. Called by dispatch() when the
 * hot path throws `HttpSchemaError`, `HttpBotChallengeError`, or `HttpServerError`
 * and the Stagehand browser path is engaged instead.
 */
export function recordFallbackActivation(siteId: string): void {
  ensureEntry(siteId).fallbackActivations++;
}

/**
 * Records a rate-limit rejection for `siteId`. Called by dispatch() when the
 * hot path throws `HttpRateLimitError` (429 from the target). A rising count
 * signals the configured rps ceiling needs to be lowered.
 */
export function recordRateLimitRejection(siteId: string): void {
  ensureEntry(siteId).rateLimitRejections++;
}

/**
 * Records a hot-path round-trip latency sample and updates the p95 percentile.
 * Reservoir is capped at RESERVOIR_SIZE to bound memory; once full, a random
 * slot is replaced (Vitter's Algorithm R). Called by dispatch() on non-cached
 * hot-path successes only — cache hits are memory reads and must not bias the
 * upstream latency signal.
 */
export function recordHotPathLatency(siteId: string, latencyMs: number): void {
  const entry = ensureEntry(siteId);
  // biome-ignore lint/style/noNonNullAssertion: ensureEntry() always sets this key
  const reservoir = latencyStore.get(siteId)!;
  if (reservoir.length < RESERVOIR_SIZE) {
    reservoir.push(latencyMs);
  } else {
    reservoir[Math.floor(Math.random() * RESERVOIR_SIZE)] = latencyMs;
  }
  const sorted = [...reservoir].sort((a, b) => a - b);
  entry.p95LatencyMs = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
}

/**
 * Returns a snapshot of all per-site counters. Safe to expose on /readyz —
 * values are monotonically increasing integers since process start.
 */
export function allMetrics(): Record<string, SiteMetrics> {
  return Object.fromEntries(store.entries());
}

/**
 * Resets all counters. Intended for use in tests only — never call in
 * production as it discards drift-detection history.
 */
export function resetMetrics(): void {
  store.clear();
  latencyStore.clear();
}
