"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCachedResponse = getCachedResponse;
exports.clearResponseCache = clearResponseCache;
exports.cacheStats = cacheStats;
exports.getOrCreateInFlight = getOrCreateInFlight;
const node_crypto_1 = require("node:crypto");
const lru_cache_1 = require("lru-cache");
const config_1 = require("../config");
/**
 * Shared in-process response cache keyed by (endpoint, normalized body).
 * Scrape runs are expensive; a 15-minute TTL on identical requests
 * collapses duplicate traffic without staling data for typical integration
 * use cases.
 *
 * Why lru-cache: zero-dep, maintained, O(1) operations, battle-tested.
 * We set `ttl` at construction and rely on lazy expiry on get().
 */
const cache = new lru_cache_1.LRUCache({
    max: config_1.config.cache.maxEntries,
    ttl: config_1.config.cache.ttlMs,
});
/**
 * Tracks upstream calls that are currently resolving for a given key so
 * concurrent cache misses don't all fan out to the scraper. First miss
 * kicks off the work; subsequent misses await the same promise. Each
 * entry is removed after the promise settles (resolve or reject).
 */
const inFlight = new Map();
/**
 * Deterministically hashes a JSON-serializable payload for cache keys.
 * Sorts keys so object-key ordering never causes misses.
 */
function hashKey(endpoint, payload) {
    const canonical = JSON.stringify(payload, canonicalReplacer);
    return `${endpoint}:${(0, node_crypto_1.createHash)("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}
function canonicalReplacer(_key, value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const obj = value;
        const sorted = {};
        for (const key of Object.keys(obj).sort()) {
            sorted[key] = obj[key];
        }
        return sorted;
    }
    // Primitive-only arrays are set-semantic in request bodies where field
    // order carries no meaning (e.g. a list of filter tags). Sorting them
    // in the canonical form collapses ["a","b"] and ["b","a"] to the same
    // cache entry without touching arrays of objects (where order may carry
    // meaning).
    if (Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number")) {
        const copy = [...value];
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
function getCachedResponse(endpoint, payload) {
    const key = hashKey(endpoint, payload);
    return { value: cache.get(key), key };
}
/**
 * Clears the entire cache. Used by tests and by the daily refresh
 * worker after a full rebuild.
 */
function clearResponseCache() {
    cache.clear();
    inFlight.clear();
}
/**
 * Returns a snapshot of cache internals for the `/readyz` observability
 * endpoint. Exposed so the health route can surface cache pressure without
 * importing the LRU cache instance directly.
 */
function cacheStats() {
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
async function getOrCreateInFlight(key, producer) {
    const existing = inFlight.get(key);
    if (existing)
        return existing;
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
//# sourceMappingURL=response-cache.js.map