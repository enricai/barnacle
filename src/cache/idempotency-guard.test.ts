import { afterEach, describe, expect, it, vi } from "vitest";

import { UnknownOutcomeError } from "@/api/errors";
import {
  createIdempotencyGuard,
  createInMemoryIdempotencyStore,
  defaultIsSuccess,
  deriveIdempotencyKey,
  deriveOperationId,
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

describe("async operations (start/status)", () => {
  const cfg = { keyFields: ["id"] };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("start returns null without config or key; deriveOperationId is stable", async () => {
    const g = createIdempotencyGuard({ store: createInMemoryIdempotencyStore() });
    const ex = vi.fn().mockResolvedValue("v");
    expect(await g.start("s", undefined, { id: "1" }, ex)).toBeNull();
    expect(await g.start("s", cfg, {}, ex)).toBeNull();
    expect(ex).not.toHaveBeenCalled();
    expect(deriveOperationId("k")).toBe(deriveOperationId("k"));
    expect(deriveOperationId("k")).toHaveLength(32);
  });

  it("runs in background, dedupes retries, and reports pending then succeeded", async () => {
    const g = createIdempotencyGuard({ store: createInMemoryIdempotencyStore() });
    let release!: (v: string) => void;
    const ex = vi.fn(() => new Promise<string>((r) => (release = r)));
    const id = await g.start("s", cfg, { id: "1" }, ex);
    expect(id).toBeTruthy();
    expect(await g.start("s", cfg, { id: "1" }, ex)).toBe(id);
    expect(await g.status("s", id as string)).toEqual({ status: "pending" });
    release("done");
    await tick();
    await tick();
    expect(await g.status("s", id as string)).toEqual({ status: "succeeded", value: "done" });
    // finished op: a retry returns the same id without re-executing
    expect(await g.start("s", cfg, { id: "1" }, ex)).toBe(id);
    expect(ex).toHaveBeenCalledTimes(1);
    expect(await g.status("s", "nope")).toBeUndefined();
  });

  it("records failed and unknown-outcome failures", async () => {
    const g = createIdempotencyGuard({ store: createInMemoryIdempotencyStore() });
    const idF = (await g.start("s", cfg, { id: "f" }, async () => {
      throw new Error("boom");
    })) as string;
    const idU = (await g.start(
      "s",
      { ...cfg, classifyFailure: () => "unknown" as const },
      { id: "u" },
      async () => {
        throw new Error("lost");
      }
    )) as string;
    await tick();
    await tick();
    expect(await g.status("s", idF)).toEqual({ status: "failed", message: "boom" });
    const u = await g.status("s", idU);
    expect(u?.status).toBe("unknown-outcome");
  });

  it("reports pending records with no live run as interrupted; start re-runs them", async () => {
    const store = createInMemoryIdempotencyStore();
    const g1 = createIdempotencyGuard({ store });
    const id = (await g1.start(
      "s",
      cfg,
      { id: "1" },
      () => new Promise<string>(() => {})
    )) as string;
    const g2 = createIdempotencyGuard({ store });
    expect((await g2.status("s", id))?.status).toBe("unknown-outcome");
    const ex = vi.fn().mockResolvedValue("ok");
    expect(await g2.start("s", cfg, { id: "1" }, ex)).toBe(id);
    await tick();
    await tick();
    expect(ex).toHaveBeenCalledTimes(1);
    expect(await g2.status("s", id)).toEqual({ status: "succeeded", value: "ok" });
  });

  it("clears the active marker and rethrows when the store fails", async () => {
    const base = createInMemoryIdempotencyStore();
    let fail = true;
    const store = {
      ...base,
      get: (k: string) => {
        if (fail) throw new Error("store down");
        return base.get(k);
      },
    };
    const g = createIdempotencyGuard({ store });
    await expect(g.start("s", cfg, { id: "1" }, async () => 1)).rejects.toThrow("store down");
    fail = false;
    expect(await g.start("s", cfg, { id: "1" }, async () => 1)).toBeTruthy();
  });

  it("run throws on an unexpected stored record state", async () => {
    const store = {
      ...createInMemoryIdempotencyStore(),
      get: () => ({ state: "failed", message: "x" }) as never,
    };
    const g = createIdempotencyGuard({ store });
    await expect(g.run("s", cfg, { id: "1" }, async () => 1)).rejects.toThrow(
      "unexpected idempotency record state"
    );
  });
});
