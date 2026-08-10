/**
 * Pins the "not actionable" classification at the `clickDeepLocatorCandidate`
 * seam specifically — `isNodeNotActionableError` itself is unit-tested in
 * isolation by `deep-locator-scan.test.ts`, but the cascade only ever sees a
 * rejection that came out of `clickDeepLocatorCandidate` (`flow-runner.ts:6153`),
 * wrapped through `toErrorMessage` (`flow-runner.ts:6166`). This file proves
 * the predicate still fires (or correctly doesn't) against that exact seam,
 * independent of what a caller later decides to DO with the classification
 * (the cascade-policy behavior is pinned separately).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  }),
}));

import { toErrorMessage } from "@/lib/errors";
import { clickDeepLocatorCandidate } from "@/scraper/deep-locator-candidates";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  NODE_NOT_ACTIONABLE_MESSAGE,
  registerDeepLocatorHangingHop,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";
import { isNodeNotActionableError } from "@/scraper/deep-locator-scan";

async function clickAgainstNotVisibleElement(): Promise<unknown> {
  const frame: FakeDeepLocatorFrame = new Map();
  registerDeepLocatorHopElements(frame, "#apply_frame >> button", [
    { text: "Manual Application", visible: false },
  ]);
  const page = { deepLocator: makeFakeDeepLocator(frame) };
  try {
    // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
    await clickDeepLocatorCandidate(page as any, "#apply_frame", "button", 0);
    throw new Error("expected clickDeepLocatorCandidate to reject");
  } catch (error) {
    return error;
  }
}

describe("clickDeepLocatorCandidate / isNodeNotActionableError classification seam", () => {
  it("classifies the exact observed CDP -32000 layout-object rejection as not-actionable", async () => {
    const error = await clickAgainstNotVisibleElement();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(NODE_NOT_ACTIONABLE_MESSAGE);
    expect(isNodeNotActionableError(error)).toBe(true);
  });

  it("does NOT classify a plain 'element not attached' click rejection as not-actionable", async () => {
    const page = {
      deepLocator: () => ({
        nth: () => ({
          click: async () => {
            throw new Error("element not attached");
          },
        }),
      }),
    };

    let caught: unknown;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      await clickDeepLocatorCandidate(page as any, "#apply_frame", "button", 0);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("element not attached");
    expect(isNodeNotActionableError(caught)).toBe(false);
  });

  describe("wedged click (watchdog timeout)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("does NOT classify a WatchdogTimeoutError from a never-settling click as not-actionable, per the existing watchdog contract", async () => {
      const frame: FakeDeepLocatorFrame = new Map();
      const { release } = registerDeepLocatorHangingHop(frame, "#apply_frame >> button", {
        hangOn: "click",
        text: "Manual Application",
      });
      const page = { deepLocator: makeFakeDeepLocator(frame) };

      const promise = clickDeepLocatorCandidate(
        // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
        page as any,
        "#apply_frame",
        "button",
        0,
        { callTimeoutMs: 50 }
      );
      const assertion = promise.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(50);
      const error = await assertion;

      expect((error as Error).name).toBe("WatchdogTimeoutError");
      expect(isNodeNotActionableError(error)).toBe(false);

      release();
    });
  });

  it("survives being wrapped the way flow-runner.ts formats a caught click error via toErrorMessage", async () => {
    const original = await clickAgainstNotVisibleElement();

    const wrapped = new Error(`deepLocator: click threw ${toErrorMessage(original)}`);

    expect(isNodeNotActionableError(wrapped)).toBe(true);
  });

  it("classification is case-insensitive", () => {
    const upper = new Error(NODE_NOT_ACTIONABLE_MESSAGE.toUpperCase());
    const lower = new Error(NODE_NOT_ACTIONABLE_MESSAGE.toLowerCase());

    expect(isNodeNotActionableError(upper)).toBe(true);
    expect(isNodeNotActionableError(lower)).toBe(true);
  });
});
