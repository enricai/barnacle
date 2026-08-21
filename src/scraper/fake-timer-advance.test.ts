import { describe, expect, it, vi } from "vitest";
import { advanceUntilSettled } from "@/scraper/fake-timer-advance";

/** Builds an injected `advanceTimersByTimeAsync` stand-in that resolves `settleAfterCalls` (the caller's own promise resolve/reject) once its call count reaches that many — models a fake clock tick that happens to be the one crossing a pending timer's deadline, without touching real timers. */
function makeCountingAdvance(onCall: (calls: number) => void): (ms: number) => Promise<void> {
  let calls = 0;
  return async (_ms: number) => {
    calls += 1;
    onCall(calls);
  };
}

describe("advanceUntilSettled", () => {
  it("stops advancing on the tick after the promise resolves", async () => {
    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    const advanceTimersByTimeAsync = vi.fn(
      makeCountingAdvance((calls) => {
        if (calls === 3) resolvePromise();
      })
    );

    const result = await advanceUntilSettled(promise, { advanceTimersByTimeAsync });

    expect(result.settled).toBe(true);
    expect(advanceTimersByTimeAsync).toHaveBeenCalledTimes(3);
  });

  it("stops advancing on the tick after the promise rejects", async () => {
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((_resolve, reject) => {
      rejectPromise = reject;
    });
    promise.catch(() => {});
    const advanceTimersByTimeAsync = vi.fn(
      makeCountingAdvance((calls) => {
        if (calls === 4) rejectPromise(new Error("boom"));
      })
    );

    const result = await advanceUntilSettled(promise, { advanceTimersByTimeAsync });

    expect(result.settled).toBe(true);
    expect(advanceTimersByTimeAsync).toHaveBeenCalledTimes(4);
  });

  it("stops at the configured max iterations and reports settled: false when the promise never settles", async () => {
    const promise = new Promise<void>(() => {});
    const advanceTimersByTimeAsync = vi.fn(makeCountingAdvance(() => {}));

    const result = await advanceUntilSettled(promise, {
      advanceTimersByTimeAsync,
      maxIterations: 5,
    });

    expect(result.settled).toBe(false);
    expect(advanceTimersByTimeAsync).toHaveBeenCalledTimes(5);
  });

  it("advances in the configured step increments", async () => {
    const promise = new Promise<void>(() => {});
    const advanceTimersByTimeAsync = vi.fn(makeCountingAdvance(() => {}));

    await advanceUntilSettled(promise, {
      advanceTimersByTimeAsync,
      stepMs: 250,
      maxIterations: 3,
    });

    for (const call of advanceTimersByTimeAsync.mock.calls) {
      expect(call[0]).toBe(250);
    }
  });

  it("defaults to a 1000ms step and a 300-iteration cap when unset", async () => {
    const promise = new Promise<void>(() => {});
    let calls = 0;
    const advanceTimersByTimeAsync = vi.fn(async (ms: number) => {
      calls += 1;
      expect(ms).toBe(1_000);
    });

    const result = await advanceUntilSettled(promise, { advanceTimersByTimeAsync });

    expect(result.settled).toBe(false);
    expect(calls).toBe(300);
  });

  it("charges the clock nothing for ticks taken while no timer is scheduled", async () => {
    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    // Models the shape that made `flow-runner.oopif-dense-form-acceptance`
    // flaky: a deep await chain needs several turns with nothing scheduled
    // before it arms its next timer, and only that timer deserves the clock.
    const scheduled = [0, 0, 0, 1, 0, 0, 1];
    const advanceTimersByTimeAsync = vi.fn(
      makeCountingAdvance((calls) => {
        if (calls === scheduled.length) resolvePromise();
      })
    );

    const result = await advanceUntilSettled(promise, {
      advanceTimersByTimeAsync,
      getTimerCount: () => scheduled[advanceTimersByTimeAsync.mock.calls.length] ?? 0,
    });

    expect(result.settled).toBe(true);
    expect(advanceTimersByTimeAsync.mock.calls.map((call) => call[0])).toEqual([
      0, 0, 0, 1_000, 0, 0, 1_000,
    ]);
  });

  it("spends its iteration cap on clock-advancing ticks only, so idle turns never eat the virtual budget", async () => {
    const promise = new Promise<void>(() => {});
    const advanceTimersByTimeAsync = vi.fn(makeCountingAdvance(() => {}));
    // Every other tick is idle: a plain per-tick cap would stop after 2
    // advancing ticks, halving the virtual time the caller asked for.
    const result = await advanceUntilSettled(promise, {
      advanceTimersByTimeAsync,
      getTimerCount: () => advanceTimersByTimeAsync.mock.calls.length % 2,
      maxIterations: 4,
    });

    expect(result.settled).toBe(false);
    expect(advanceTimersByTimeAsync.mock.calls.filter((call) => call[0] === 1_000)).toHaveLength(4);
  });

  it("gives up after the idle cap when the promise never settles and nothing is ever scheduled", async () => {
    const promise = new Promise<void>(() => {});
    const advanceTimersByTimeAsync = vi.fn(makeCountingAdvance(() => {}));

    const result = await advanceUntilSettled(promise, {
      advanceTimersByTimeAsync,
      getTimerCount: () => 0,
      maxIdleIterations: 7,
    });

    expect(result.settled).toBe(false);
    expect(advanceTimersByTimeAsync).toHaveBeenCalledTimes(7);
  });
});
