import { createHash } from "node:crypto";

import { LRUCache } from "lru-cache";

import { config } from "@/config";

/**
 * Shared in-process response cache keyed by (endpoint, normalized body).
 * Scrape runs are expensive; a 15-minute TTL on identical requests
 * collapses duplicate traffic without compromising freshness for the
 * price-changes delta workflow.
 *
 * Why lru-cache: zero-dep, maintained, O(1) operations, battle-tested.
 * We set `ttl` at construction and rely on lazy expiry on get().
 */
const cache = new LRUCache<string, object>({
  max: config.cache.maxEntries,
  ttl: config.cache.ttlMs,
});

/**
 * Tracks upstream calls that are currently resolving for a given key so
 * concurrent cache misses don't all fan out to the scraper. First miss
 * kicks off the work; subsequent misses await the same promise. Each
 * entry is removed after the promise settles (resolve or reject).
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Deterministically hashes a JSON-serializable payload for cache keys.
 * Sorts keys so object-key ordering never causes misses.
 */
function hashKey(endpoint: string, payload: unknown): string {
  const canonical = JSON.stringify(payload, canonicalReplacer);
  return `${endpoint}:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

function canonicalReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = obj[key];
    }
    return sorted;
  }
  // Primitive-only arrays are set-semantic in every request body we
  // cache today (shipCodes, destinations, departurePorts, currencyCodes,
  // agencyTypes). Sorting them in the canonical form collapses
  // ["CARIB","BAHAM"] and ["BAHAM","CARIB"] to the same cache entry
  // without touching arrays of objects (where order may carry meaning).
  if (Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number")) {
    const copy = [...value] as Array<string | number>;
    copy.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return copy;
  }
  return value;
}

/**
 * Looks up a cached response by `endpoint` + `payload` (the normalized
 * request body). Returns the cache key so callers can write the value
 * back via `getOrCreateInFlight` without re-hashing.
 */
export function getCachedResponse<T>(
  endpoint: string,
  payload: unknown
): { value: T | undefined; key: string } {
  const key = hashKey(endpoint, payload);
  return { value: cache.get(key) as T | undefined, key };
}

/**
 * Clears the entire cache. Used by tests and by the daily refresh
 * worker after a full rebuild.
 */
export function clearResponseCache(): void {
  cache.clear();
  inFlight.clear();
}

export function cacheStats(): { size: number; max: number; inFlight: number } {
  return { size: cache.size, max: cache.max, inFlight: inFlight.size };
}

/**
 * Runs `producer` once per key even when multiple callers race on a
 * cache miss. The first caller kicks off the upstream call and all
 * concurrent callers await the same promise. On resolve, the value is
 * written to the LRU cache so subsequent (non-racing) reads hit
 * normally.
 *
 * Callers still do the `getCachedResponse` check first — this helper
 * is only invoked on a miss. Rejection propagates to every awaiter so
 * one caller's failure doesn't look like success to the rest.
 */
export async function getOrCreateInFlight<T extends object>(
  key: string,
  producer: () => Promise<T>
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  // Deliberately .then/.finally rather than await: we must register the
  // promise in `inFlight` synchronously so concurrent callers that race
  // into this function hit the existing entry. An `await` here would
  // yield before the `inFlight.set` below, defeating coalescing.
  const promise = producer()
    .then((value) => {
      cache.set(key, value);
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}
