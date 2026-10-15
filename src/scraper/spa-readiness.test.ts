import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { regateSpaAfterOriginChange, waitForSpaReady } from "@/scraper/spa-readiness";
import type { Logger } from "@/types/logging";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/**
 * Fake page whose `evaluate` returns a scripted sequence of body lengths (one
 * per call) and whose `waitForTimeout` is a spy — so a test can assert the poll
 * loop's timing behavior without a real browser.
 */
function fakePage(bodyLengths: number[]): {
  page: Page;
  waitForTimeout: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  const waitForTimeout = vi.fn().mockResolvedValue(undefined);
  const page = {
    evaluate: vi.fn().mockImplementation(async () => {
      const v = bodyLengths[Math.min(call, bodyLengths.length - 1)];
      call += 1;
      return v;
    }),
    waitForTimeout,
  } as unknown as Page;
  return { page, waitForTimeout };
}

describe("spa-readiness/waitForSpaReady", () => {
  it("returns immediately without polling when the body already exceeds the threshold", async () => {
    const { page, waitForTimeout } = fakePage([9000]);
    await waitForSpaReady(page, testLogger, { minBodyLength: 5000 });
    expect(waitForTimeout).not.toHaveBeenCalled();
  });

  it("polls until the SPA body grows past the threshold, then returns", async () => {
    const { page, waitForTimeout } = fakePage([100, 100, 8000]);
    await waitForSpaReady(page, testLogger, {
      minBodyLength: 5000,
      timeoutMs: 10_000,
      pollMs: 10,
    });
    expect(waitForTimeout).toHaveBeenCalledTimes(2);
  });

  it("proceeds (never throws) when the body stays below the threshold until timeout", async () => {
    const { page, waitForTimeout } = fakePage([100]);
    await expect(
      waitForSpaReady(page, testLogger, { minBodyLength: 5000, timeoutMs: 25, pollMs: 10 })
    ).resolves.toBeUndefined();
    expect(waitForTimeout.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("treats a non-numeric evaluate result as zero and keeps waiting", async () => {
    let call = 0;
    const waitForTimeout = vi.fn().mockResolvedValue(undefined);
    const page = {
      evaluate: vi.fn().mockImplementation(async () => {
        call += 1;
        return call >= 2 ? 8000 : undefined;
      }),
      waitForTimeout,
    } as unknown as Page;
    await waitForSpaReady(page, testLogger, { minBodyLength: 5000, timeoutMs: 10_000, pollMs: 10 });
    expect(waitForTimeout).toHaveBeenCalledTimes(1);
  });

  it("resolves within its own budget (never hangs) when page.evaluate never settles", async () => {
    vi.useFakeTimers();
    try {
      const waitForTimeout = vi.fn().mockResolvedValue(undefined);
      const page = {
        // Every readBodyLength probe hangs forever — without a per-probe
        // watchdog this would pend waitForSpaReady indefinitely, since the
        // `while (Date.now() < deadline)` loop is never re-entered.
        evaluate: vi.fn().mockImplementation(() => new Promise(() => {})),
        waitForTimeout,
      } as unknown as Page;

      const resultPromise = waitForSpaReady(page, testLogger, {
        minBodyLength: 5000,
        timeoutMs: 1000,
        pollMs: 100,
      });
      const assertion = expect(resultPromise).resolves.toBeUndefined();

      // Advance well past the 1000ms budget (each poll iteration itself
      // costs one pollMs-bounded watchdog wait) so the deadline loop is
      // guaranteed to have exited by the time this assertion checks it.
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;

      expect(testLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("proceeding with possibly incomplete page")
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("spa-readiness/regateSpaAfterOriginChange", () => {
  const fast = { timeoutMs: 20, pollMs: 5 };

  function pageWithReload(bodyLengths: number[]): { page: Page; reload: ReturnType<typeof vi.fn> } {
    const { page } = fakePage(bodyLengths);
    const reload = vi.fn().mockResolvedValue(undefined);
    (page as unknown as { reload: unknown }).reload = reload;
    return { page, reload };
  }

  it("does not reload when the body renders on the first wait", async () => {
    const { page, reload } = pageWithReload([9000]);
    await regateSpaAfterOriginChange(page, testLogger, fast);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads once with domcontentloaded when the body stays an empty shell", async () => {
    const { page, reload } = pageWithReload([10]);
    reload.mockImplementation(async () => {
      (page.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(9000);
    });
    await regateSpaAfterOriginChange(page, testLogger, fast);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith({ waitUntil: "domcontentloaded" });
  });

  it("runs the readiness poll again after the reload", async () => {
    const { page, reload } = pageWithReload([10]);
    let evaluatesAtReload = -1;
    reload.mockImplementation(async () => {
      evaluatesAtReload = (page.evaluate as ReturnType<typeof vi.fn>).mock.calls.length;
    });
    await regateSpaAfterOriginChange(page, testLogger, fast);
    expect(evaluatesAtReload).toBeGreaterThan(0);
    expect((page.evaluate as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      evaluatesAtReload
    );
  });

  it("reloads exactly once and does not throw when still empty after reload", async () => {
    const { page, reload } = pageWithReload([10]);
    await expect(regateSpaAfterOriginChange(page, testLogger, fast)).resolves.toBeUndefined();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
