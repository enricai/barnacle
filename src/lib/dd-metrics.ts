/**
 * Typed DogStatsD wrappers for operational dispatch metrics. These supplement
 * the in-memory counters in src/scraper/metrics.ts (which power /readyz) with
 * durable Datadog-side aggregation for alerting and dashboards.
 */
import { getStatsD } from "@/lib/statsd";

export interface DispatchTags {
  site: string;
  path: "http" | "browser";
}

export interface FailureDispatchTags extends DispatchTags {
  error_type: string;
}

function toTagArray(tags: object): string[] {
  return Object.entries(tags).map(([k, v]) => `${k}:${v}`);
}

/** Increments `dispatch.attempt` — one per plugin invocation. */
export function recordDdAttempt(tags: DispatchTags): void {
  getStatsD().increment("dispatch.attempt", 1, toTagArray(tags));
}

/** Increments `dispatch.success`. */
export function recordDdSuccess(tags: DispatchTags): void {
  getStatsD().increment("dispatch.success", 1, toTagArray(tags));
}

/** Increments `dispatch.failure` with error classification. */
export function recordDdFailure(tags: FailureDispatchTags): void {
  getStatsD().increment("dispatch.failure", 1, toTagArray(tags));
}

/** Records end-to-end dispatch latency as a timing distribution. */
export function recordDdDuration(tags: DispatchTags, durationMs: number): void {
  getStatsD().timing("dispatch.duration_ms", durationMs, toTagArray(tags));
}

/** Increments `dispatch.fallback` — hot-path failed, browser engaged. */
export function recordDdFallback(site: string): void {
  getStatsD().increment("dispatch.fallback", 1, [`site:${site}`]);
}

/** Increments `dispatch.rate_limit` — target site returned 429. */
export function recordDdRateLimit(site: string): void {
  getStatsD().increment("dispatch.rate_limit", 1, [`site:${site}`]);
}
