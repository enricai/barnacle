import { describe, expect, it } from "vitest";

import {
  cacheStats,
  clearResponseCache,
  getCachedResponse,
  setCachedResponse,
} from "@/cache/response-cache";

describe("response-cache", () => {
  it("stores and retrieves by endpoint+payload", () => {
    clearResponseCache();
    const { key, value } = getCachedResponse("/v1/test", { a: 1, b: 2 });
    expect(value).toBeUndefined();
    setCachedResponse(key, { ok: true });
    const { value: retrieved } = getCachedResponse("/v1/test", { a: 1, b: 2 });
    expect(retrieved).toEqual({ ok: true });
  });

  it("treats object key ordering as the same request", () => {
    clearResponseCache();
    const first = getCachedResponse("/v1/test", { a: 1, b: 2 });
    setCachedResponse(first.key, { stable: true });
    const { value } = getCachedResponse("/v1/test", { b: 2, a: 1 });
    expect(value).toEqual({ stable: true });
  });

  it("scopes keys by endpoint", () => {
    clearResponseCache();
    const first = getCachedResponse("/v1/a", { x: 1 });
    setCachedResponse(first.key, "a");
    const second = getCachedResponse("/v1/b", { x: 1 });
    expect(second.value).toBeUndefined();
  });

  it("clearResponseCache empties the store", () => {
    clearResponseCache();
    const { key } = getCachedResponse("/v1/test", { foo: "bar" });
    setCachedResponse(key, 42);
    expect(cacheStats().size).toBeGreaterThan(0);
    clearResponseCache();
    expect(cacheStats().size).toBe(0);
  });
});
