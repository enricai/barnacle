"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCachedResponse = getCachedResponse;
exports.setCachedResponse = setCachedResponse;
exports.clearResponseCache = clearResponseCache;
exports.cacheStats = cacheStats;
const node_crypto_1 = require("node:crypto");
const lru_cache_1 = require("lru-cache");
const config_1 = require("@/config");
/**
 * Shared in-process response cache keyed by (endpoint, normalized body).
 * Scrape runs are expensive; a 15-minute TTL on identical requests
 * collapses duplicate traffic without compromising freshness for the
 * price-changes delta workflow.
 *
 * Why lru-cache: zero-dep, maintained, O(1) operations, battle-tested.
 * We set `ttl` at construction and rely on lazy expiry on get().
 */
const cache = new lru_cache_1.LRUCache({
    max: config_1.config.cache.maxEntries,
    ttl: config_1.config.cache.ttlMs,
});
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
    return value;
}
/**
 * Looks up a cached response by `endpoint` + `payload` (the normalized
 * request body). Returns the cache key so callers can `setResponse`
 * later without re-hashing.
 */
function getCachedResponse(endpoint, payload) {
    const key = hashKey(endpoint, payload);
    return { value: cache.get(key), key };
}
function setCachedResponse(key, value) {
    cache.set(key, value);
}
/**
 * Clears the entire cache. Used by tests and by the daily refresh
 * worker after a full rebuild.
 */
function clearResponseCache() {
    cache.clear();
}
function cacheStats() {
    return { size: cache.size, max: cache.max };
}
//# sourceMappingURL=response-cache.js.map