import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { StepVerificationError } from "@/scraper/errors";
import {
  buildNavigateSettle,
  createCaptureTracker,
  NAVIGATE_SETTLE_QUIET_MS,
} from "@/scraper/navigate";
import { executeNavigateStep, GOTO_TIMEOUT_MS } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** Fake page whose `goto` is scripted and whose `evaluate` reports a body length past the SPA-readiness threshold on the first read, so tests don't need to wait out the poll loop. */
function fakePage(opts: { gotoImpl: () => Promise<void>; bodyLength?: number }): {
  page: Page;
  goto: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const goto = vi.fn().mockImplementation(opts.gotoImpl);
  const evaluate = vi.fn().mockResolvedValue(opts.bodyLength ?? 6_000);
  const page = { goto, evaluate } as unknown as Page;
  return { page, goto, evaluate };
}

describe("flow-runner/executeNavigateStep", () => {
  it("navigates, waits for SPA readiness, and returns completed on success", async () => {
    const { page, goto, evaluate } = fakePage({ gotoImpl: async () => undefined });

    const outcome = await executeNavigateStep({
      page,
      url: "https://example.com/list",
      optional: false,
      logger: testLogger,
    });

    expect(outcome).toBe("completed");
    expect(goto).toHaveBeenCalledWith("https://example.com/list", {
      waitUntil: "domcontentloaded",
      timeoutMs: GOTO_TIMEOUT_MS,
    });
    // waitForSpaReady reads body length after the goto resolves — proves the
    // readiness gate actually fired post-navigation rather than being skipped.
    expect(evaluate).toHaveBeenCalled();
  });

  it("returns skipped when an optional step's goto fails", async () => {
    const { page, evaluate } = fakePage({
      gotoImpl: async () => {
        throw new Error("net::ERR_NAME_NOT_RESOLVED");
      },
    });

    const outcome = await executeNavigateStep({
      page,
      url: "https://example.com/list",
      optional: true,
      logger: testLogger,
    });

    expect(outcome).toBe("skipped");
    // The readiness gate never runs when goto itself failed.
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("throws StepVerificationError with kind navigate-failed when a required step's goto fails", async () => {
    const { page } = fakePage({
      gotoImpl: async () => {
        throw new Error("net::ERR_CONNECTION_REFUSED");
      },
    });

    await expect(
      executeNavigateStep({
        page,
        url: "https://example.com/list",
        optional: false,
        logger: testLogger,
      })
    ).rejects.toMatchObject({
      constructor: StepVerificationError,
      kind: "navigate-failed",
    });
  });

  it("passes a custom waitUntil/timeoutMs through to goto", async () => {
    const { page, goto } = fakePage({ gotoImpl: async () => undefined });

    await executeNavigateStep({
      page,
      url: "https://example.com/list",
      optional: false,
      logger: testLogger,
      waitUntil: "load",
      timeoutMs: 5_000,
    });

    expect(goto).toHaveBeenCalledWith("https://example.com/list", {
      waitUntil: "load",
      timeoutMs: 5_000,
    });
  });
});

describe("flow-runner/executeNavigateStep settle", () => {
  const settleOpts = { endpointRx: /\/graphql/, bodyRx: /SearchQuery/ };

  it("does not return until a body-matching capture plus quiet window; URL-only chrome capture does not satisfy", async () => {
    const tracker = createCaptureTracker();
    const { page } = fakePage({
      gotoImpl: async () => {
        tracker.observe("https://x.com/graphql", '{"operationName":"Chrome"}');
      },
    });
    vi.useFakeTimers();
    try {
      let done = false;
      const p = executeNavigateStep({
        page,
        url: "https://x.com/list",
        optional: false,
        logger: testLogger,
        settle: () => ({
          wait: tracker.begin(settleOpts).wait,
        }),
      }).then((r) => {
        done = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(done).toBe(false);
      tracker.observe("https://x.com/graphql", '{"operationName":"SearchQuery"}');
      await vi.advanceTimersByTimeAsync(NAVIGATE_SETTLE_QUIET_MS + 50);
      expect(await p).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("proceeds with a warning on timeout and does not wait without a settle hook", async () => {
    const tracker = createCaptureTracker();
    const { page } = fakePage({ gotoImpl: async () => undefined });
    const warn = vi.fn();
    const logger = { ...testLogger, warn } as unknown as Logger;
    const outcome = await executeNavigateStep({
      page,
      url: "https://x.com/list",
      optional: false,
      logger,
      settle: () => {
        const w = tracker.begin(settleOpts);
        return { wait: () => w.wait({ timeoutMs: 30, quietMs: 5 }) };
      },
    });
    expect(outcome).toBe("completed");
    expect(warn).toHaveBeenCalled();
    expect(buildNavigateSettle(tracker, null)).toBeUndefined();
  });
});
