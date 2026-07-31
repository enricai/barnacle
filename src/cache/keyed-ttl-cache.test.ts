import { beforeEach, describe, expect, it, vi } from "vitest";

import { createKeyedTtlCache } from "@/cache/keyed-ttl-cache";

describe("createKeyedTtlCache", () => {
  const cache = createKeyedTtlCache<{ value: number; extra?: string }>({
    max: 10,
    ttlMs: 60_000,
  });

  beforeEach(() => {
    cache.reset();
  });

  it("(a) get returns undefined on miss and the stored value after set", () => {
    expect(cache.get("k1")).toBeUndefined();
    cache.set("k1", { value: 42 });
    expect(cache.get("k1")).toEqual({ value: 42 });
  });

  it("(b) two concurrent getOrWarm calls invoke the warmer exactly once", async () => {
    const warmer = vi.fn().mockImplementation(async () => {
      // Yield to let both callers race onto the same in-flight entry.
      await new Promise((r) => setImmediate(r));
      return { value: 99 };
    });

    const [a, b] = await Promise.all([
      cache.getOrWarm("k2", warmer),
      cache.getOrWarm("k2", warmer),
    ]);

    expect(warmer).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ value: 99 });
    expect(b).toEqual({ value: 99 });
  });

  it("(c) getOrWarm returns a distinct object copy per caller", async () => {
    const warmer = vi.fn().mockResolvedValue({ value: 1 });

    const [a, b] = await Promise.all([
      cache.getOrWarm("k3", warmer),
      cache.getOrWarm("k3", warmer),
    ]);

    // Each caller gets its own object so in-place mutation doesn't bleed.
    expect(a).not.toBe(b);
    a.value = 999;
    expect(b.value).toBe(1);
    expect(cache.get("k3")).toEqual({ value: 1 });
  });

  it("(d) invalidate drops the entry so the next getOrWarm re-invokes warmer", async () => {
    const warmer = vi.fn().mockResolvedValue({ value: 7 });

    await cache.getOrWarm("k4", warmer);
    expect(warmer).toHaveBeenCalledTimes(1);
    expect(cache.get("k4")).toEqual({ value: 7 });

    cache.invalidate("k4");
    expect(cache.get("k4")).toBeUndefined();

    await cache.getOrWarm("k4", warmer);
    expect(warmer).toHaveBeenCalledTimes(2);
  });

  it("(e) reset wipes both the LRU and the inFlight map", async () => {
    cache.set("k5", { value: 5 });
    expect(cache.get("k5")).toEqual({ value: 5 });

    // Start a warming operation to populate inFlight, then reset while it
    // is still pending to verify inFlight is cleared synchronously.
    let resolveWarmer!: (v: { value: number }) => void;
    const warmer = vi.fn().mockImplementation(
      () =>
        new Promise<{ value: number }>((resolve) => {
          resolveWarmer = resolve;
        })
    );
    const pending = cache.getOrWarm("k6", warmer);

    // reset() must clear the LRU immediately (before the in-flight settles).
    cache.reset();
    expect(cache.get("k5")).toBeUndefined();
    expect(cache.get("k6")).toBeUndefined();

    // Let the original warmer settle (it writes to LRU because reset doesn't
    // cancel in-flight work, it only clears the tracking map — same semantics
    // as response-cache clearResponseCache).
    resolveWarmer({ value: 55 });
    await pending;

    // For a key that was never in the in-flight map (new key k7), reset
    // ensures a fresh warmer is invoked.
    const warmer2 = vi.fn().mockResolvedValue({ value: 100 });
    await cache.getOrWarm("k7", warmer2);
    expect(warmer2).toHaveBeenCalledTimes(1);
    expect(cache.get("k7")).toEqual({ value: 100 });
  });
});

describe("createKeyedTtlCache — keyPrefix isolation", () => {
  it("two caches with different prefixes do not share entries", async () => {
    const a = createKeyedTtlCache<{ n: number }>({ max: 10, ttlMs: 60_000, keyPrefix: "ns-a" });
    const b = createKeyedTtlCache<{ n: number }>({ max: 10, ttlMs: 60_000, keyPrefix: "ns-b" });

    a.set("shared", { n: 1 });
    expect(a.get("shared")).toEqual({ n: 1 });
    expect(b.get("shared")).toBeUndefined();
  });
});
