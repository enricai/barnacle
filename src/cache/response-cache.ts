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
  return value;
}

export interface CachedLookup<T> {
  value: T | undefined;
  key: string;
}

/**
 * Looks up a cached response by `endpoint` + `payload` (the normalized
 * request body). Returns the cache key so callers can `setResponse`
 * later without re-hashing.
 */
export function getCachedResponse<T>(endpoint: string, payload: unknown): CachedLookup<T> {
  const key = hashKey(endpoint, payload);
  return { value: cache.get(key) as T | undefined, key };
}

export function setCachedResponse<T>(key: string, value: T): void {
  cache.set(key, value as unknown as object);
}

/**
 * Clears the entire cache. Used by tests and by the daily refresh
 * worker after a full rebuild.
 */
export function clearResponseCache(): void {
  cache.clear();
}

export function cacheStats(): { size: number; max: number } {
  return { size: cache.size, max: cache.max };
}
