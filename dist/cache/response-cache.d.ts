/**
 * Looks up a cached response by `endpoint` + `payload` (the normalized
 * request body). Returns the cache key so callers can write the value
 * back via `getOrCreateInFlight` without re-hashing.
 */
export declare function getCachedResponse<T>(endpoint: string, payload: unknown): {
    value: T | undefined;
    key: string;
};
/**
 * Clears the entire cache. Used by tests and by the daily refresh
 * worker after a full rebuild.
 */
export declare function clearResponseCache(): void;
/**
 * Returns a snapshot of cache internals for the `/readyz` observability
 * endpoint. Exposed so the health route can surface cache pressure without
 * importing the LRU cache instance directly.
 */
export declare function cacheStats(): {
    size: number;
    max: number;
    inFlight: number;
};
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
export declare function getOrCreateInFlight<T extends object>(key: string, producer: () => Promise<T>): Promise<T>;
