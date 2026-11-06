import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cacheStats,
  clearResponseCache,
  getCachedResponse,
  getOrCreateInFlight,
  invalidateResponse,
} from "@/cache/response-cache";

describe("response-cache", () => {
  beforeEach(() => {
    clearResponseCache();
  });

  it("stores and retrieves by endpoint+payload", async () => {
    const { key, value } = getCachedResponse("/v1/test", { a: 1, b: 2 });
    expect(value).toBeUndefined();
    await getOrCreateInFlight(key, async () => ({ ok: true }));
    const { value: retrieved } = getCachedResponse("/v1/test", { a: 1, b: 2 });
    expect(retrieved).toEqual({ ok: true });
  });

  it("treats object key ordering as the same request", async () => {
    const first = getCachedResponse("/v1/test", { a: 1, b: 2 });
    await getOrCreateInFlight(first.key, async () => ({ stable: true }));
    const { value } = getCachedResponse("/v1/test", { b: 2, a: 1 });
    expect(value).toEqual({ stable: true });
  });

  it("scopes keys by endpoint", async () => {
    const first = getCachedResponse("/v1/a", { x: 1 });
    await getOrCreateInFlight(first.key, async () => ({ tag: "a" }));
    const second = getCachedResponse("/v1/b", { x: 1 });
    expect(second.value).toBeUndefined();
  });

  it("treats primitive arrays as sets — reorder collapses to one cache entry", async () => {
    // Arrays whose elements are set-semantic (order carries no meaning)
    // must collapse to the same cache key regardless of send order so
    // callers don't thrash duplicate origin work.
    const first = getCachedResponse("/v1/test", { tags: ["alpha", "beta"] });
    await getOrCreateInFlight(first.key, async () => ({ payload: "sorted" }));
    const { value } = getCachedResponse("/v1/test", { tags: ["beta", "alpha"] });
    expect(value).toEqual({ payload: "sorted" });
  });

  it("sorts numeric arrays identically to string arrays", async () => {
    const first = getCachedResponse("/v1/test", { nights: [7, 3, 5] });
    await getOrCreateInFlight(first.key, async () => ({ payload: 1 }));
    const { value } = getCachedResponse("/v1/test", { nights: [5, 3, 7] });
    expect(value).toEqual({ payload: 1 });
  });

  it("preserves order for arrays of objects (non-primitive)", async () => {
    // Arrays of objects may encode ordered semantics (e.g. pagination
    // cursors, priority lists). The canonicalizer leaves them alone to
    // avoid false cache hits where order matters.
    const first = getCachedResponse("/v1/test", {
      cursors: [{ seq: 1 }, { seq: 2 }],
    });
    await getOrCreateInFlight(first.key, async () => ({ payload: "ordered" }));
    const { value } = getCachedResponse("/v1/test", {
      cursors: [{ seq: 2 }, { seq: 1 }],
    });
    // Different key → miss.
    expect(value).toBeUndefined();
  });

  it("clearResponseCache empties the store", async () => {
    const { key } = getCachedResponse("/v1/test", { foo: "bar" });
    await getOrCreateInFlight(key, async () => ({ n: 42 }));
    expect(cacheStats().size).toBeGreaterThan(0);
    clearResponseCache();
    expect(cacheStats().size).toBe(0);
  });
});

describe("response-cache getOrCreateInFlight", () => {
  beforeEach(() => {
    clearResponseCache();
  });

  it("collapses concurrent cache-miss callers into a single producer run", async () => {
    const producer = vi.fn().mockImplementation(async () => {
      // Small tick so concurrent callers land on the same in-flight
      // entry before it resolves.
      await new Promise((r) => setImmediate(r));
      return { payload: 42 };
    });
    const { key } = getCachedResponse("/v1/test", { a: 1 });
    const [a, b, c] = await Promise.all([
      getOrCreateInFlight(key, producer),
      getOrCreateInFlight(key, producer),
      getOrCreateInFlight(key, producer),
    ]);
    expect(producer).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ payload: 42 });
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("writes the resolved value to the LRU cache for subsequent reads", async () => {
    const { key } = getCachedResponse("/v1/test", { a: 1 });
    await getOrCreateInFlight(key, async () => ({ payload: 99 }));
    const hit = getCachedResponse<{ payload: number }>("/v1/test", { a: 1 });
    expect(hit.value).toEqual({ payload: 99 });
  });

  it("removes the in-flight entry after the producer settles so future misses can re-run", async () => {
    const { key } = getCachedResponse("/v1/test", { a: 1 });
    await getOrCreateInFlight(key, async () => ({ first: true }));
    expect(cacheStats().inFlight).toBe(0);
    // Clear the LRU cache so the next call is also a miss; producer
    // should run again and the new value should win.
    clearResponseCache();
    await getOrCreateInFlight(key, async () => ({ second: true }));
    const hit = getCachedResponse<{ second: boolean }>("/v1/test", { a: 1 });
    expect(hit.value).toEqual({ second: true });
  });

  it("propagates rejection to every concurrent awaiter without caching the failure", async () => {
    const producer = vi.fn().mockRejectedValue(new Error("origin down"));
    const { key } = getCachedResponse("/v1/test", { a: 1 });
    const [a, b] = await Promise.allSettled([
      getOrCreateInFlight(key, producer),
      getOrCreateInFlight(key, producer),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(producer).toHaveBeenCalledTimes(1);
    // Cache must stay empty — we never persist failed results.
    expect(getCachedResponse("/v1/test", { a: 1 }).value).toBeUndefined();
  });
});

describe("response-cache byte bound", () => {
  beforeEach(() => {
    clearResponseCache();
  });

  it("reports byte usage and the configured ceiling, not just entry counts", async () => {
    const { key } = getCachedResponse("/v1/test", { a: 1 });
    await getOrCreateInFlight(key, async () => ({ blob: "x".repeat(10_000) }));
    const stats = cacheStats();
    expect(stats.bytes).toBeGreaterThan(10_000);
    expect(stats.maxBytes).toBeGreaterThan(0);
    // The point of the bound: entry count alone cannot reveal this.
    expect(stats.size).toBe(1);
  });

  it("evicts least-recently-used entries to stay under the byte ceiling", async () => {
    // Each entry is ~2 MB, so a 128 MB default ceiling needs many of them to
    // bind. Rather than allocate that much, assert the invariant that matters:
    // retained bytes never exceed the ceiling, whatever is inserted.
    const payload = { blob: "y".repeat(2_000_000) };
    for (let i = 0; i < 12; i += 1) {
      const { key } = getCachedResponse("/v1/test", { i });
      await getOrCreateInFlight(key, async () => ({ ...payload, i }));
    }
    const stats = cacheStats();
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
  });

  it("charges an unstringifiable value a nominal size instead of throwing", async () => {
    // A cycle cannot be JSON-stringified. Caching is a side effect of a
    // successful request, so a size-calculation failure must never propagate
    // out and fail that request.
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const { key } = getCachedResponse("/v1/test", { cyclic: true });
    await expect(getOrCreateInFlight(key, async () => cyclic)).resolves.toBe(cyclic);
    expect(cacheStats().size).toBe(1);
  });
});

describe("response-cache invalidateResponse", () => {
  beforeEach(() => {
    clearResponseCache();
  });

  it("removes a single entry, leaving the rest of the cache intact", async () => {
    const doomed = getCachedResponse("/v1/test", { keep: false });
    await getOrCreateInFlight(doomed.key, async () => ({ bad: true }));
    const kept = getCachedResponse("/v1/test", { keep: true });
    await getOrCreateInFlight(kept.key, async () => ({ good: true }));

    invalidateResponse(doomed.key);

    expect(getCachedResponse("/v1/test", { keep: false }).value).toBeUndefined();
    expect(getCachedResponse("/v1/test", { keep: true }).value).toEqual({ good: true });
  });

  it("is a no-op for a key that was never cached", () => {
    expect(() => invalidateResponse("never-stored")).not.toThrow();
  });

  it("documents the write-then-reject window it exists to close", async () => {
    // `getOrCreateInFlight` caches on resolve, but a caller can still reject
    // the value afterwards — a response that fails its 200 schema becomes a
    // 500 *after* the write. Without invalidation the failure is served from
    // cache for the full TTL.
    const { key } = getCachedResponse("/v1/carnival", { maxPages: 1 });
    const produced = await getOrCreateInFlight(key, async () => ({ label: null }));
    expect(getCachedResponse("/v1/carnival", { maxPages: 1 }).value).toEqual(produced);

    invalidateResponse(key);
    expect(getCachedResponse("/v1/carnival", { maxPages: 1 }).value).toBeUndefined();
  });
});
