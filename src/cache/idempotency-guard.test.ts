import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UnknownOutcomeError } from "@/api/errors";
import {
  createFileIdempotencyStore,
  createIdempotencyGuard,
  createInMemoryIdempotencyStore,
  defaultIsSuccess,
  deriveIdempotencyKey,
  deriveOperationId,
} from "@/cache/idempotency-guard";
import { registerSecretValue, resetSensitiveValuesForTests } from "@/lib/pii-redaction";
import { TaskDeadlineError } from "@/scraper/errors";

afterEach(() => {
  vi.useRealTimers();
  resetSensitiveValuesForTests();
});

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

  it("treats TaskDeadlineError (direct or as originalError) as unknown outcome", async () => {
    const c = { keyFields: ["id"] };
    const wrapped = Object.assign(new Error("wrapped"), { originalError: new TaskDeadlineError() });
    for (const [id, e] of [
      ["1", new TaskDeadlineError()],
      ["2", wrapped],
    ] as const) {
      const g = createIdempotencyGuard();
      const ex = vi.fn().mockRejectedValue(e);
      await expect(g.run("s", c, { id }, ex)).rejects.toBe(e);
      await expect(g.run("s", c, { id }, ex)).rejects.toBeInstanceOf(UnknownOutcomeError);
      expect(ex).toHaveBeenCalledTimes(1);
    }
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

  it("settles a reopened sync retry using its once-mapped refusal", async () => {
    const g = createIdempotencyGuard({ store: createInMemoryIdempotencyStore() });
    const id = (await g.start("s", cfg, { id: "1" }, async () => {
      throw new Error("first failure");
    })) as string;
    await vi.waitFor(async () => expect((await g.status("s", id))?.status).toBe("failed"));

    const refusal = new UnknownOutcomeError("verify the outcome");
    const refusalFor = vi.fn(async () => refusal);
    let rejectRetry!: (err: Error) => void;
    const retry = g.run(
      "s",
      { ...cfg, refusalFor },
      { id: "1" },
      () => new Promise<string>((_, reject) => (rejectRetry = reject))
    );
    await vi.waitFor(async () => expect((await g.status("s", id))?.status).toBe("pending"));
    rejectRetry(new Error("retry failure"));
    await expect(retry).rejects.toBe(refusal);
    expect(refusalFor).toHaveBeenCalledTimes(1);
    expect(await g.status("s", id)).toEqual({
      status: "unknown-outcome",
      message: "verify the outcome",
    });
    const executeAgain = vi.fn(async () => "unexpected");
    expect(await g.start("s", cfg, { id: "1" }, executeAgain)).toBe(id);
    expect(executeAgain).not.toHaveBeenCalled();
  });

  it("settles an async start using its once-mapped refusal", async () => {
    const g = createIdempotencyGuard({ store: createInMemoryIdempotencyStore() });
    const refusalFor = vi.fn(async () => new UnknownOutcomeError("verify async outcome"));
    const id = (await g.start("s", { ...cfg, refusalFor }, { id: "1" }, async () => {
      throw new Error("failure");
    })) as string;
    await vi.waitFor(async () =>
      expect(await g.status("s", id)).toEqual({
        status: "unknown-outcome",
        message: "verify async outcome",
      })
    );
    expect(refusalFor).toHaveBeenCalledTimes(1);
  });

  it("reports pending records with no live run as interrupted; start does not re-run them", async () => {
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
    expect(ex).not.toHaveBeenCalled();
    expect((await g2.status("s", id))?.status).toBe("unknown-outcome");
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

describe("durable store reload", () => {
  it("replays a success and blocks an unknown outcome after a simulated restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-"));
    try {
      const cfg = {
        keyFields: ["ref"],
        classifyFailure: (e: unknown) => ((e as Error).message === "lost" ? "unknown" : "failed"),
      } as never;
      const g1 = createIdempotencyGuard({ store: createFileIdempotencyStore(dir) });
      await g1.run("fict-site", cfg, { ref: "a" }, async () => "done");
      await expect(
        g1.run("fict-site", cfg, { ref: "b" }, async () => {
          throw new Error("lost");
        })
      ).rejects.toThrow("lost");
      const g2 = createIdempotencyGuard({ store: createFileIdempotencyStore(dir) });
      const exec = vi.fn(async () => "again");
      expect(await g2.run("fict-site", cfg, { ref: "a" }, exec)).toBe("done");
      await expect(g2.run("fict-site", cfg, { ref: "b" }, exec)).rejects.toBeInstanceOf(
        UnknownOutcomeError
      );
      expect(exec).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("guard lifecycle", () => {
  const cfg = { keyFields: ["id"] };
  const flush = async () => {
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
  };

  it("renews the lease past 5 minutes so a second guard does not take it", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "idem-"));
    try {
      const store = createFileIdempotencyStore(dir);
      let release!: (v: string) => void;
      const ex1 = vi.fn(() => new Promise<string>((r) => (release = r)));
      const ex2 = vi.fn().mockResolvedValue("second");
      const g1 = createIdempotencyGuard({ store });
      const g2 = createIdempotencyGuard({ store });
      const p1 = g1.run("s", cfg, { id: "1" }, ex1);
      await flush();
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      const p2 = g2.run("s", cfg, { id: "1" }, ex2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ex2).not.toHaveBeenCalled();
      release("first");
      await vi.advanceTimersByTimeAsync(100);
      expect(await p1).toBe("first");
      expect(await p2).toBe("first");
      expect(ex2).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a run that lost its lease failing does not delete the new owner's claim", async () => {
    const store = createInMemoryIdempotencyStore();
    store.claim = (key, ttl, owner) => {
      if (store.get(key)) return false;
      store.set(key, { state: "pending", owner }, ttl);
      return true;
    };
    const g = createIdempotencyGuard({ store });
    let fail!: (e: Error) => void;
    const p = g.run("s", cfg, { id: "1" }, () => new Promise<string>((_, rej) => (fail = rej)));
    await new Promise((r) => setTimeout(r, 5));
    const key = JSON.stringify(["s", "1"]);
    store.set(key, { state: "pending", owner: "other" }, 1000);
    fail(new Error("x"));
    await expect(p).rejects.toThrow("x");
    expect(store.get(key)).toEqual({ state: "pending", owner: "other" });
  });

  it("unknown never overwrites success", async () => {
    const store = createInMemoryIdempotencyStore();
    const g = createIdempotencyGuard({ store });
    const key = JSON.stringify(["s", "1"]);
    const p = g.run(
      "s",
      { ...cfg, classifyFailure: () => "unknown" as const },
      { id: "1" },
      async () => {
        store.set(key, { state: "success", value: "ok" }, 1000);
        throw new Error("late");
      }
    );
    await expect(p).rejects.toThrow("late");
    expect(store.get(key)).toEqual({ state: "success", value: "ok" });
  });

  it("redacts async failure messages and a sync resend settles the reopened op", async () => {
    registerSecretValue("hunter2-secret");
    const store = createInMemoryIdempotencyStore();
    const g = createIdempotencyGuard({ store });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const id = (await g.start("s", cfg, { id: "1" }, async () => {
      throw new Error("bad hunter2-secret");
    })) as string;
    await tick();
    await tick();
    const failed = await g.status("s", id);
    expect(failed?.status).toBe("failed");
    expect(JSON.stringify(failed)).not.toContain("hunter2-secret");
    let release!: (v: string) => void;
    const p = g.run("s", cfg, { id: "1" }, () => new Promise<string>((r) => (release = r)));
    await tick();
    expect(await g.status("s", id)).toEqual({ status: "pending" });
    release("done");
    await p;
    expect(await g.status("s", id)).toEqual({ status: "succeeded", value: "done" });
  });
});

describe("record write isolation", () => {
  const cfg = {
    keyFields: ["id"],
    classifyFailure: (e: unknown) =>
      e instanceof Error && e.message === "boom" ? ("unknown" as const) : ("failed" as const),
  };
  const failingStore = () => {
    const base = createInMemoryIdempotencyStore();
    return {
      ...base,
      set: () => Promise.reject(new Error("disk full")),
    };
  };

  it("keeps the run's error when recording an unknown outcome fails, and warns", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const g = createIdempotencyGuard({ store: failingStore() });
    await expect(
      g.run("s", cfg, { id: "1" }, () => Promise.reject(new Error("boom")))
    ).rejects.toThrow("boom");
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("failed to record unknown outcome: disk full")
    );
    write.mockRestore();
  });

  it("redacts secrets in write-failure warnings", async () => {
    registerSecretValue("hunter2-secret");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const base = createInMemoryIdempotencyStore();
    const store = { ...base, set: () => Promise.reject(new Error("disk full hunter2-secret")) };
    const g = createIdempotencyGuard({ store });
    expect(await g.run("s", cfg, { id: "1" }, async () => 1)).toBe(1);
    expect(write).toHaveBeenCalledWith(expect.stringContaining("failed to record success outcome"));
    expect(write).not.toHaveBeenCalledWith(expect.stringContaining("hunter2-secret"));
    write.mockRestore();
  });

  it("returns the run's value when recording a success fails, and warns", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const g = createIdempotencyGuard({ store: failingStore() });
    expect(await g.run("s", cfg, { id: "1" }, async () => ({ ok: 1 }))).toEqual({ ok: 1 });
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("failed to record success outcome: disk full")
    );
    write.mockRestore();
  });
  it("warns instead of swallowing when start() cannot record the final outcome", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const base = createInMemoryIdempotencyStore();
    let calls = 0;
    const store = {
      ...base,
      set: (...a: Parameters<typeof base.set>) =>
        ++calls === 1 ? base.set(...a) : Promise.reject(new Error("disk full")),
    };
    const g = createIdempotencyGuard({ store });
    await g.start("s", cfg, { id: "1" }, async () => 1);
    await vi.waitFor(() =>
      expect(write).toHaveBeenCalledWith(
        expect.stringContaining("failed to record operation outcome: disk full")
      )
    );
    write.mockRestore();
  });
});

describe("leased runs release the lease", () => {
  const cfg = { keyFields: ["id"] };
  const leasedStore = () => {
    const base = createInMemoryIdempotencyStore();
    return {
      ...base,
      claim: vi.fn((key: string, ttl: number, owner?: string) => {
        base.set(key, { state: "pending", owner }, ttl);
        return true;
      }),
      delete: vi.fn(),
    };
  };

  it("deletes the lease when the run fails with a known error", async () => {
    const store = leasedStore();
    const g = createIdempotencyGuard({ store });
    await expect(
      g.run("s", cfg, { id: "1" }, () => Promise.reject(new Error("nope")))
    ).rejects.toThrow("nope");
    expect(store.delete).toHaveBeenCalledTimes(1);
  });

  it("deletes the lease when the result is not a success", async () => {
    const store = leasedStore();
    const g = createIdempotencyGuard({ store });
    await g.run("s", cfg, { id: "1" }, async () => ({ needsUserInfo: true }));
    expect(store.delete).toHaveBeenCalledTimes(1);
  });
});

describe("leased runs when the outcome write fails", () => {
  const cfg = {
    keyFields: ["id"],
    classifyFailure: (e: unknown) =>
      e instanceof Error && e.message === "boom" ? ("unknown" as const) : ("failed" as const),
  };
  const leasedFailingStore = () => {
    const base = createInMemoryIdempotencyStore();
    return {
      ...base,
      claim: vi.fn((key: string, ttl: number, owner?: string) => {
        base.set(key, { state: "pending", owner }, ttl);
        return true;
      }),
      delete: vi.fn(),
      set: () => Promise.reject(new Error("disk full")),
    };
  };

  it("returns the value and keeps the claim when set fails after success", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const store = leasedFailingStore();
    const g = createIdempotencyGuard({ store });
    expect(await g.run("s", cfg, { id: "1" }, async () => ({ ok: 1 }))).toEqual({ ok: 1 });
    expect(store.delete).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it("rethrows the original error and keeps the claim when set fails after unknown error", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const store = leasedFailingStore();
    const g = createIdempotencyGuard({ store });
    await expect(
      g.run("s", cfg, { id: "1" }, () => Promise.reject(new Error("boom")))
    ).rejects.toThrow("boom");
    expect(store.delete).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it("still releases the claim for a known failure when set would fail", async () => {
    const store = leasedFailingStore();
    const g = createIdempotencyGuard({ store });
    await expect(
      g.run("s", cfg, { id: "1" }, () => Promise.reject(new Error("nope")))
    ).rejects.toThrow("nope");
    expect(store.delete).toHaveBeenCalledTimes(1);
  });
});

describe("guard refusalFor", () => {
  const failingStore = () => ({
    get: () => {
      throw new Error("store down");
    },
    set: () => undefined,
    delete: () => undefined,
  });
  it("maps a store.get failure in run() through refusalFor", async () => {
    const guard = createIdempotencyGuard({ store: failingStore() });
    const refusal = new Error("refused");
    await expect(
      guard.run(
        "s",
        { keyFields: ["a"], refusalFor: async () => refusal },
        { a: "1" },
        async () => 1
      )
    ).rejects.toBe(refusal);
  });
  it("maps a pre-run store.set failure in start() through refusalFor", async () => {
    const guard = createIdempotencyGuard({
      store: {
        get: () => undefined,
        set: () => {
          throw new Error("store down");
        },
        delete: () => undefined,
      },
    });
    const refusal = new Error("refused");
    await expect(
      guard.start(
        "s",
        { keyFields: ["a"], refusalFor: async () => refusal },
        { a: "1" },
        async () => 1
      )
    ).rejects.toBe(refusal);
  });
  it("leaves the error unchanged without refusalFor", async () => {
    const guard = createIdempotencyGuard({ store: failingStore() });
    await expect(guard.run("s", { keyFields: ["a"] }, { a: "1" }, async () => 1)).rejects.toThrow(
      "store down"
    );
  });
});
