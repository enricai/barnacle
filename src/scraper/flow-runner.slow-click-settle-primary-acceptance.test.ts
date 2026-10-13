import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * A click whose DOM change and network response land ~6s late must be verified
 * on attempt 1 (act-string). The post-click snapshot has to wait for the
 * click's network activity to settle instead of a fixed pause, otherwise the
 * cascade re-clicks on attempt 2.
 */

const guardedObserve = vi.fn();
const guardedAct = vi.fn();

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
    guardedAct: (...args: unknown[]) => guardedAct(...args),
  };
});

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const STEP = "confirm the shipping address and continue";
const RESOLVED_SELECTOR = "css=button#continue";
const PRE_URL = "https://example.org/checkout/shipping";
const POST_URL = "https://example.org/checkout/payment";
const LATE_MS = 6_000;
const IDLE_GIVE_UP_MS = 8_000;
const STEP_PAUSE_MS = 2_000;

interface Clock {
  now: number;
  clickedAt: number | null;
  url: string;
  counter: { n: number };
}

/** Virtual-clock page: waitForTimeout advances time, and the delayed response lands once `lateMs` has elapsed since the click. */
function fakePage(clock: Clock, lateMs: number | null): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: () => clock.url,
    title: vi.fn().mockResolvedValue("App"),
    waitForTimeout: vi.fn(async (ms: number): Promise<void> => {
      clock.now += ms;
      if (lateMs === null || clock.clickedAt === null) return;
      if (clock.url === PRE_URL && clock.now - clock.clickedAt >= lateMs) {
        clock.url = POST_URL;
        clock.counter.n += 1;
      }
    }),
  } as unknown as Page;
}

function baseParams(
  page: Page,
  signalCounter: { n: number },
  trajectory: unknown[]
): Record<string, unknown> {
  return {
    stagehand: {} as unknown as Stagehand,
    page,
    step: STEP,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 0,
    totalSteps: () => 1,
    phase: "flow",
    signalCounter,
    trajectory,
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
    uploadFixture: null,
    isFinalStep: false,
    submitEndpointPattern: null,
    submittedStateSelectors: [],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: null,
    successUrlFragments: [],
    successPageTitleHints: [],
    ownBackendHostnames: [],
    knownErrorClassPrefixes: [],
    wizardExitButtonLabels: [],
  };
}

describe("flow-runner/executeStepWithHealing — slow click settles in the primary attempt loop", () => {
  let clock: Clock;
  let actTimes: number[];

  beforeEach(() => {
    vi.clearAllMocks();
    clock = { now: 0, clickedAt: null, url: PRE_URL, counter: { n: 0 } };
    actTimes = [];
    guardedObserve.mockResolvedValueOnce([
      { selector: RESOLVED_SELECTOR, description: "Continue", method: "click" },
    ]);
    guardedObserve.mockResolvedValue([]);
    guardedAct.mockImplementation(async () => {
      actTimes.push(clock.now);
      clock.clickedAt = clock.now;
      return {
        success: true,
        message: "clicked",
        actionDescription: "Continue",
        actions: [{ selector: RESOLVED_SELECTOR, description: "Continue", method: "click" }],
      };
    });
  });

  it("credits a ~6s delayed click on attempt 1 with no second act call", async () => {
    const page = fakePage(clock, LATE_MS);
    const trajectory: { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"] }[] = [];

    const outcome = await executeStepWithHealing(
      baseParams(page, clock.counter, trajectory) as never
    );

    expect(outcome).toBe("completed");
    expect(guardedAct).toHaveBeenCalledTimes(1);
    expect(trajectory.length).toBeGreaterThan(0);
  });

  it("with no activity gives up after at most IDLE_GIVE_UP_MS of extra settle", async () => {
    const page = fakePage(clock, null);
    const trajectory: { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"] }[] = [];

    const outcome = await executeStepWithHealing(
      baseParams(page, clock.counter, trajectory) as never
    ).catch(() => "threw");

    expect(outcome).not.toBe("completed");
    expect(trajectory.some((t) => t.verifiedBy !== undefined && t.verifiedBy !== null)).toBe(false);
    expect(guardedAct.mock.calls.length).toBeGreaterThan(0);
    const waited = clock.now - actTimes[0];
    expect(waited).toBeGreaterThanOrEqual(STEP_PAUSE_MS + IDLE_GIVE_UP_MS);
  });
});
