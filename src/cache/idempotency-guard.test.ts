import { afterEach, describe, expect, it, vi } from "vitest";

import { UnknownOutcomeError } from "@/api/errors";
import {
  createIdempotencyGuard,
  createInMemoryIdempotencyStore,
  defaultIsSuccess,
  deriveIdempotencyKey,
} from "@/cache/idempotency-guard";

afterEach(() => vi.useRealTimers());

describe("deriveIdempotencyKey", () => {
  it("returns null without fields, body, or with missing/blank/invalid fields", () => {
    expect(deriveIdempotencyKey("s", [], { a: "x" })).toBeNull();
    expect(deriveIdempotencyKey("s", ["a"], null)).toBeNull();
    expect(deriveIdempotencyKey("s", ["a"], "str")).toBeNull();
    expect(deriveIdempotencyKey("s", ["a"], { a: "  " })).toBeNull();
    expect(deriveIdempotencyKey("s", ["a"], {})).toBeNull();
    expect(deriveIdempotencyKey("s", ["a"], { a: {} })).toBeNull();
  });
  it("builds a key from trimmed strings, numbers and booleans", () => {
    expect(deriveIdempotencyKey("s", ["a", "b", "c"], { a: " x ", b: 2, c: false })).toBe(
      JSON.stringify(["s", "x", "2", "false"])
    );
  });
});

describe("defaultIsSuccess", () => {
  it("rejects needsUserInfo, accepts others", () => {
    expect(defaultIsSuccess({ needsUserInfo: true })).toBe(false);
    expect(defaultIsSuccess({ ok: 1 })).toBe(true);
    expect(defaultIsSuccess(null)).toBe(true);
    expect(defaultIsSuccess("x")).toBe(true);
  });
});

describe("in-memory store", () => {
  it("gets, expires and deletes", () => {
    vi.useFakeTimers();
    const s = createInMemoryIdempotencyStore();
    expect(s.get("k")).toBeUndefined();
    s.set("k", { state: "success", value: 1 }, 100);
    expect(s.get("k")).toEqual({ state: "success", value: 1 });
    vi.advanceTimersByTime(101);
    expect(s.get("k")).toBeUndefined();
    s.set("k", { state: "success", value: 1 }, 100);
    s.delete("k");
    expect(s.get("k")).toBeUndefined();
  });
});

describe("createIdempotencyGuard", () => {
  const cfg = { keyFields: ["id"] };

  it("executes directly with no config or no key", async () => {
    const g = createIdempotencyGuard();
    const ex = vi.fn().mockResolvedValue("v");
    await g.run("s", undefined, { id: "1" }, ex);
    await g.run("s", cfg, {}, ex);
    await g.run("s", cfg, {}, ex);
    expect(ex).toHaveBeenCalledTimes(3);
  });

  it("joins concurrent duplicates and replays a recent success", async () => {
    const g = createIdempotencyGuard();
    const ex = vi.fn().mockResolvedValue({ n: 1 });
    const [a, b] = await Promise.all([
      g.run("s", cfg, { id: "1" }, ex),
      g.run("s", cfg, { id: "1" }, ex),
    ]);
    expect(a).toEqual(b);
    expect(await g.run("s", cfg, { id: "1" }, ex)).toEqual({ n: 1 });
    expect(ex).toHaveBeenCalledTimes(1);
    await g.run("s", cfg, { id: "2" }, ex);
    expect(ex).toHaveBeenCalledTimes(2);
  });

  it("does not record non-success results or plain failures", async () => {
    const g = createIdempotencyGuard();
    const ex = vi.fn().mockResolvedValue({ needsUserInfo: true });
    await g.run("s", cfg, { id: "1" }, ex);
    await g.run("s", cfg, { id: "1" }, ex);
    expect(ex).toHaveBeenCalledTimes(2);

    const fail = vi.fn().mockRejectedValue(new Error("boom"));
    const c = { keyFields: ["id"], classifyFailure: () => "failed" as const };
    await expect(g.run("s", c, { id: "2" }, fail)).rejects.toThrow("boom");
    await expect(g.run("s", c, { id: "2" }, fail)).rejects.toThrow("boom");
    expect(fail).toHaveBeenCalledTimes(2);
  });

  it("records unknown failures and throws UnknownOutcomeError on duplicates", async () => {
    const g = createIdempotencyGuard();
    const c = { keyFields: ["id"], classifyFailure: () => "unknown" as const };
    const ex = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(g.run("s", c, { id: "1" }, ex)).rejects.toThrow("timeout");
    const p = g.run("s", c, { id: "1" }, ex);
    await expect(p).rejects.toBeInstanceOf(UnknownOutcomeError);
    await expect(p).rejects.toThrow(/timeout/);
    expect(ex).toHaveBeenCalledTimes(1);
    // non-Error throw is stringified
    await expect(g.run("s", c, { id: "3" }, () => Promise.reject("raw"))).rejects.toBe("raw");
    await expect(g.run("s", c, { id: "3" }, ex)).rejects.toThrow(/raw/);
  });

  it("honours custom store and ttl", async () => {
    vi.useFakeTimers();
    const g = createIdempotencyGuard({ ttlMs: 50 });
    const ex = vi.fn().mockResolvedValue(1);
    await g.run("s", cfg, { id: "1" }, ex);
    vi.advanceTimersByTime(51);
    await g.run("s", cfg, { id: "1" }, ex);
    expect(ex).toHaveBeenCalledTimes(2);
  });
});
