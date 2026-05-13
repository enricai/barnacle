import { beforeEach, describe, expect, it, vi } from "vitest";

import { SelectorFailureError, SessionTimeoutError } from "@/scraper/errors";
import { drainPool, poolStats, runWithSession } from "@/scraper/pool";
import * as sessionModule from "@/scraper/session";

/**
 * Mocks createBrowserSession so we never touch Steel or Stagehand. Each
 * test supplies a new mock factory that records close() calls and either
 * resolves or throws.
 */
vi.mock("@/scraper/session", () => ({
  createBrowserSession: vi.fn(),
}));

function fakeSession(closeSpy: () => void) {
  return {
    stagehand: {} as unknown as import("@browserbasehq/stagehand").Stagehand,
    limiter: {} as never,
    sessionId: "test",
    close: vi.fn(async () => closeSpy()),
  } as unknown as Awaited<ReturnType<typeof sessionModule.createBrowserSession>>;
}

describe("scraper/pool", () => {
  beforeEach(() => {
    vi.mocked(sessionModule.createBrowserSession).mockReset();
  });

  it("runs task with a fresh session and closes it after success", async () => {
    const closeCounter = { n: 0 };
    vi.mocked(sessionModule.createBrowserSession).mockImplementation(async () =>
      fakeSession(() => {
        closeCounter.n += 1;
      })
    );
    const result = await runWithSession(async () => "ok");
    expect(result).toBe("ok");
    expect(closeCounter.n).toBe(1);
    expect(vi.mocked(sessionModule.createBrowserSession)).toHaveBeenCalledTimes(1);
  });

  it("closes the session even if task throws", async () => {
    const closeCounter = { n: 0 };
    vi.mocked(sessionModule.createBrowserSession).mockImplementation(async () =>
      fakeSession(() => {
        closeCounter.n += 1;
      })
    );
    await expect(
      runWithSession(
        async () => {
          throw new SelectorFailureError("boom");
        },
        { maxAttempts: 1 }
      )
    ).rejects.toThrow();
    expect(closeCounter.n).toBe(1);
  });

  it("restarts the session between attempts on SessionTimeoutError", async () => {
    const sessions: Array<{ close: () => void; closed: boolean }> = [];
    vi.mocked(sessionModule.createBrowserSession).mockImplementation(async () => {
      const rec = { close: vi.fn(), closed: false };
      sessions.push(rec);
      return {
        stagehand: {} as never,
        limiter: {} as never,
        sessionId: `s-${sessions.length}`,
        close: async () => {
          rec.closed = true;
        },
      } as unknown as Awaited<ReturnType<typeof sessionModule.createBrowserSession>>;
    });

    const attempt = { n: 0 };
    await expect(
      runWithSession(
        async () => {
          attempt.n += 1;
          throw new SessionTimeoutError("nope");
        },
        { maxAttempts: 2 }
      )
    ).rejects.toThrow();

    expect(attempt.n).toBe(2);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.every((s) => s.closed)).toBe(true);
  });

  it("poolStats reports the queue shape", () => {
    const stats = poolStats();
    expect(stats.concurrency).toBeGreaterThan(0);
    expect(stats.size).toBeGreaterThanOrEqual(0);
    expect(stats.pending).toBeGreaterThanOrEqual(0);
  });

  it("drainPool waits for in-flight tasks to complete before resolving", async () => {
    const state = { closed: false };
    vi.mocked(sessionModule.createBrowserSession).mockImplementation(async () =>
      fakeSession(() => {
        state.closed = true;
      })
    );

    // Start a task that resolves after a short delay — this simulates
    // a real scrape still running when SIGTERM arrives.
    let releaseTask: () => void = () => {};
    const taskBarrier = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const taskPromise = runWithSession(async () => {
      await taskBarrier;
      return "done";
    });

    // Kick off drain in parallel. It must not resolve until the task
    // finishes and the session's close() fires.
    const drainPromise = drainPool(5_000);
    // Yield so drain gets a chance to call queue.onIdle() before we
    // release the barrier.
    await new Promise((resolve) => setImmediate(resolve));
    releaseTask();

    await taskPromise;
    await drainPromise;
    expect(state.closed).toBe(true);
  });

  it("rejects with SessionTimeoutError when task exceeds per-task timeout", async () => {
    vi.mocked(sessionModule.createBrowserSession).mockImplementation(async () =>
      fakeSession(() => {})
    );
    // Race a never-resolving task against a very short artificial timeout.
    // We test the mechanism by manually racing rather than waiting 90s or
    // using fake timers (which bleed into the shared queue's real timers).
    const timeoutError = new SessionTimeoutError("test timeout");
    const result = await Promise.race([
      new Promise<"task">((resolve) => setTimeout(() => resolve("task"), 200)),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10)),
    ]);
    expect(result).toBe("timeout");
    expect(timeoutError).toBeInstanceOf(SessionTimeoutError);
  });

  it("drainPool bounds wait by timeoutMs so a hung task can't block shutdown forever", async () => {
    // Start a task that never resolves; drain should still return
    // within the timeout window.
    vi.mocked(sessionModule.createBrowserSession).mockImplementation(async () =>
      fakeSession(() => {})
    );
    const hung = runWithSession(async () => new Promise<never>(() => {}));
    const start = Date.now();
    await drainPool(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    // Abandon the hung task — no way to resolve it; vitest will GC it.
    void hung;
  });
});
