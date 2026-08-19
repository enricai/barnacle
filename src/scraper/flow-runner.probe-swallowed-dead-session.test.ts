import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHop,
} from "@/scraper/deep-locator-fake";
import { probeStepBeforeAttempts } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for docs/recon-1126-midstep-session-death-swallowed-by-flowrunner-probe.md:
 * exercises all three of `probeStepBeforeAttempts`'s "treat as present"
 * swallow branches (unfocused-observe-present, deepLocator-present, and
 * probe-threw) under one shared dead-session fixture, plus a live-session
 * control for each shape, so a future regression that reintroduces the
 * swallow fails immediately.
 */

const guardedObserve = vi.fn();

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
  };
});

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const FRAME_SELECTOR = "iframe#widget_frame";

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

/** Child `FrameTarget` whose `evaluate` answers snapshotPage's `{html,text}` probe so pre/post captures don't throw. */
function makeChildFrameTarget(): FrameTarget {
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: FRAME_SELECTOR,
    evaluate: vi.fn().mockResolvedValue({ html: 0, text: "0:" }),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: () => Promise.resolve("https://widget.example.org/booking"),
    title: () => Promise.resolve("Booking"),
  };
}

/** `deepLocator`-capable fake `Page` whose `url()` either throws (dead) or resolves (live). */
function makeDeepLocatorPage(frame: FakeDeepLocatorFrame, dead: boolean): Page {
  return {
    deepLocator: makeFakeDeepLocator(frame),
    url: () => {
      if (dead) throw new Error("Target page, context or browser has been closed");
      return "https://widget.example.org/booking";
    },
  } as unknown as Page;
}

/** Plain fake `Page` (no `deepLocator`) whose `url()` either throws (dead) or resolves (live). */
function makePlainPage(dead: boolean): Page {
  return {
    url: () => {
      if (dead) throw new Error("Target page, context or browser has been closed");
      return "https://widget.example.org/booking";
    },
  } as unknown as Page;
}

describe("flow-runner/probeStepBeforeAttempts — all swallow branches under a dead session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects with SessionTimeoutError instead of returning present at the deepLocator branch when the session is dead", async () => {
    guardedObserve.mockResolvedValue([]);
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHop(frame, `${FRAME_SELECTOR} >> *`);

    await expect(
      probeStepBeforeAttempts({
        stagehand: makeStagehand(),
        page: makeDeepLocatorPage(frame, true),
        step: "Fill in the shipping address field",
        stepIndex: 0,
        logger: testLogger,
        frameTarget: makeChildFrameTarget(),
      })
    ).rejects.toThrow(/session appears closed\/dead/);
  });

  it("rejects with SessionTimeoutError instead of returning present at the unfocused-observe branch when the session is dead", async () => {
    guardedObserve
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { selector: "input#shipping", description: "shipping address", method: "fill" },
      ]);

    await expect(
      probeStepBeforeAttempts({
        stagehand: makeStagehand(),
        page: makePlainPage(true),
        step: "Fill in the shipping address field",
        stepIndex: 0,
        logger: testLogger,
      })
    ).rejects.toThrow(/session appears closed\/dead/);
  });

  it("rejects with SessionTimeoutError instead of returning present at the probe-threw catch branch when the session is dead", async () => {
    guardedObserve.mockRejectedValueOnce(new Error("observe timed out"));

    await expect(
      probeStepBeforeAttempts({
        stagehand: makeStagehand(),
        page: makePlainPage(true),
        step: "Fill in the shipping address field",
        stepIndex: 0,
        logger: testLogger,
      })
    ).rejects.toThrow(/session appears closed\/dead/);
  });

  it("still resolves present/absent exactly as before on a live session for all three shapes (control, no regression)", async () => {
    // deepLocator branch, live session.
    guardedObserve.mockResolvedValue([]);
    const frame: FakeDeepLocatorFrame = new Map();
    registerDeepLocatorHop(frame, `${FRAME_SELECTOR} >> *`);
    const deepLocatorResult = await probeStepBeforeAttempts({
      stagehand: makeStagehand(),
      page: makeDeepLocatorPage(frame, false),
      step: "Fill in the shipping address field",
      stepIndex: 0,
      logger: testLogger,
      frameTarget: makeChildFrameTarget(),
    });
    expect(deepLocatorResult).toBe("present");

    // unfocused-observe branch, live session.
    vi.clearAllMocks();
    guardedObserve
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { selector: "input#shipping", description: "shipping address", method: "fill" },
      ]);
    const unfocusedResult = await probeStepBeforeAttempts({
      stagehand: makeStagehand(),
      page: makePlainPage(false),
      step: "Fill in the shipping address field",
      stepIndex: 0,
      logger: testLogger,
    });
    expect(unfocusedResult).toBe("present");

    // probe-threw branch, live session.
    vi.clearAllMocks();
    guardedObserve.mockRejectedValueOnce(new Error("observe timed out"));
    const threwResult = await probeStepBeforeAttempts({
      stagehand: makeStagehand(),
      page: makePlainPage(false),
      step: "Fill in the shipping address field",
      stepIndex: 0,
      logger: testLogger,
    });
    expect(threwResult).toBe("present");

    // Both observes empty (focused and unfocused), live session: legitimate "absent".
    vi.clearAllMocks();
    guardedObserve.mockResolvedValue([]);
    const absentResult = await probeStepBeforeAttempts({
      stagehand: makeStagehand(),
      page: makePlainPage(false),
      step: "Fill in the shipping address field",
      stepIndex: 0,
      logger: testLogger,
    });
    expect(absentResult).toBe("absent");
  });
});
