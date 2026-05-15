import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cacheStats,
  clearResponseCache,
  getCachedResponse,
  getOrCreateInFlight,
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
    // callers don't thrash duplicate upstream work.
    const first = getCachedResponse("/v1/test", { damageTypes: ["roof", "flooding"] });
    await getOrCreateInFlight(first.key, async () => ({ payload: "sorted" }));
    const { value } = getCachedResponse("/v1/test", { damageTypes: ["flooding", "roof"] });
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
    const producer = vi.fn().mockRejectedValue(new Error("upstream down"));
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
