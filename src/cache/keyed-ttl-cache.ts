import { LRUCache } from "lru-cache";

/**
 * Generic per-key TTL cache factory with single-flight warmup coalescing.
 *
 * Why this exists: both `src/cache/response-cache.ts` and
 * `src/sites/appcast/tokens/cache.ts` independently hand-roll the same
 * inFlight Map + LRUCache wiring. Any future site needing a per-key token
 * or session cache would copy it a third time. This factory captures the
 * shared invariant — promise registered synchronously before any yield so
 * concurrent callers coalesce onto one warmup — and adds the shallow-copy-
 * on-read behaviour the token cache needs (returned snapshot is isolated
 * from subsequent in-place mutations of the master entry).
 */

export interface KeyedTtlCacheOptions {
  max: number;
  ttlMs: number;
  keyPrefix?: string;
}

export interface KeyedTtlCache<T extends object> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  invalidate(key: string): void;
  getOrWarm(key: string, warmer: () => Promise<T>): Promise<T>;
  reset(): void;
}

/**
 * Builds a keyed TTL cache with single-flight coalescing and copy-on-read.
 *
 * Pass `{ max, ttlMs }` to control capacity and expiry. An optional
 * `keyPrefix` namespaces the underlying LRU keys so multiple caches in the
 * same process can share a debug view without colliding.
 *
 * The returned `getOrWarm` uses `.then/.finally` (not `await`) so the
 * in-flight promise is written to the map *synchronously* — before any
 * microtask yield — guaranteeing that every concurrent caller for the same
 * key awaits the same promise instead of kicking off a duplicate warmup.
 * See the same pattern at `response-cache.ts:108-111` and
 * `appcast/tokens/cache.ts:124-125`.
 *
 * `getOrWarm` returns `{ ...value }` (a shallow copy) to each caller so
 * that an in-place mutation of the master cache entry (e.g. rotating a
 * header field) does not bleed into a snapshot already in the hands of
 * another caller.
 */
export function createKeyedTtlCache<T extends object>(
  options: KeyedTtlCacheOptions
): KeyedTtlCache<T> {
  const { max, ttlMs, keyPrefix = "" } = options;

  const lru = new LRUCache<string, T>({ max, ttl: ttlMs });
  const inFlight = new Map<string, Promise<T>>();

  function prefixed(key: string): string {
    return keyPrefix ? `${keyPrefix}:${key}` : key;
  }

  function get(key: string): T | undefined {
    return lru.get(prefixed(key));
  }

  function set(key: string, value: T): void {
    lru.set(prefixed(key), value);
  }

  function invalidate(key: string): void {
    lru.delete(prefixed(key));
  }

  function getOrWarm(key: string, warmer: () => Promise<T>): Promise<T> {
    const cached = get(key);
    if (cached) return Promise.resolve({ ...cached } as T);

    const pk = prefixed(key);
    const existing = inFlight.get(pk);
    if (existing) return existing.then((v) => ({ ...v }) as T);

    // Deliberately .then/.finally rather than await: we must register the
    // promise in `inFlight` synchronously so concurrent callers that race
    // into this function hit the existing entry. An `await` here would
    // yield before the `inFlight.set` below, defeating coalescing.
    const promise = warmer()
      .then((value) => {
        lru.set(pk, value);
        return value;
      })
      .finally(() => {
        inFlight.delete(pk);
      });
    inFlight.set(pk, promise);
    return promise.then((v) => ({ ...v }) as T);
  }

  function reset(): void {
    lru.clear();
    inFlight.clear();
  }

  return { get, set, invalidate, getOrWarm, reset };
}
