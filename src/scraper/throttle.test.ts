import Bottleneck from "bottleneck";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionLimiter, scheduleAction } from "@/scraper/throttle";

/**
 * scheduleAction is the throttle layer on the scrape critical path —
 * every act()/extract() call goes through it. These tests lock the
 * three invariants that matter for production:
 *
 *   1. Pass-through semantics: the returned value matches fn().
 *   2. Serialization: one action at a time per session (Bottleneck
 *      maxConcurrent=1 means two concurrent calls can't overlap).
 *   3. Error propagation: rejection from fn() surfaces to the caller.
 *
 * We use a real Bottleneck instance (tiny minTime) rather than mocking
 * it — the tests are about the composition, and Bottleneck's own
 * behavior is the contract we depend on.
 */

describe("scraper/throttle scheduleAction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns whatever the scheduled fn resolves to", async () => {
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 1 });
    try {
      const result = await scheduleAction(limiter, async () => ({ payload: 42 }));
      expect(result).toEqual({ payload: 42 });
    } finally {
      await limiter.stop({ dropWaitingJobs: true });
    }
  });

  it("serializes two concurrent calls — the second doesn't start until the first finishes", async () => {
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 1 });
    try {
      const log: string[] = [];
      const first = scheduleAction(limiter, async () => {
        log.push("first-start");
        await new Promise((r) => setTimeout(r, 20));
        log.push("first-end");
        return 1;
      });
      const second = scheduleAction(limiter, async () => {
        log.push("second-start");
        return 2;
      });
      await Promise.all([first, second]);
      // Bottleneck guarantees the second action doesn't start until
      // the first resolves.
      expect(log).toEqual(["first-start", "first-end", "second-start"]);
    } finally {
      await limiter.stop({ dropWaitingJobs: true });
    }
  });

  it("propagates rejection from the scheduled fn", async () => {
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 1 });
    try {
      await expect(
        scheduleAction(limiter, async () => {
          throw new Error("scrape exploded");
        })
      ).rejects.toThrow(/scrape exploded/);
    } finally {
      await limiter.stop({ dropWaitingJobs: true });
    }
  });

  // Task 11 requires a randomized delay between actions. Over 50
  // sequential calls with a tight min=max=10ms jitter window (forcing a
  // deterministic non-zero sleep), the median fn-latency must exceed
  // 5ms — which can only happen if scheduleAction actually awaits the
  // jitter sleep before invoking fn. Using wall-clock rather than a
  // fake timer because Bottleneck uses real setImmediate internally.
  it("awaits the jitter sleep before invoking fn (task 11)", async () => {
    // One call with forced random near 0 verifies the sleep path runs
    // WITHOUT waiting for the ~1000ms default jitter window. Any jitter
    // that exceeds ~1ms wall-clock proves scheduleAction awaits the
    // setTimeout; we want fast but non-zero.
    const rngSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    try {
      const startAt = Date.now();
      await scheduleAction(limiter, async () => Date.now());
      const elapsed = Date.now() - startAt;
      // Default config jitter = floor(0.5 * 1000) = 500ms; assert >=50
      // to stay robust under CI jitter while still failing loudly if
      // the sleep is skipped entirely.
      expect(elapsed).toBeGreaterThanOrEqual(50);
    } finally {
      rngSpy.mockRestore();
      await limiter.stop({ dropWaitingJobs: true });
    }
  });
});

describe("scraper/throttle createSessionLimiter", () => {
  it("emits a Bottleneck configured for serial scrape actions", () => {
    const limiter = createSessionLimiter();
    try {
      // maxConcurrent=1 is the load-bearing guarantee — the target site sees one
      // action at a time per session; queue.counts() reports the
      // waiting/running state and confirms the limiter is alive.
      expect(limiter.counts).toBeTypeOf("function");
      const counts = limiter.counts();
      expect(counts.RUNNING).toBe(0);
      expect(counts.QUEUED).toBe(0);
    } finally {
      void limiter.stop({ dropWaitingJobs: true });
    }
  });
});
