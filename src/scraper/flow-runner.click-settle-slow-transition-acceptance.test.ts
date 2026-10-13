import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Integration-level guard for the post-click settle wiring in
 * `executeStepWithHealing`'s primary loop: a click whose DOM change and
 * network response land ~6s late (a slow client-side transition) must be
 * verified on attempt 1 rather than judged a no-effect click and retried,
 * while a click with no activity at all still falls through after roughly
 * the helper's idle give-up window. Time is a virtual clock advanced by the
 * fake page's `waitForTimeout`, so nothing actually sleeps.
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

const STEP = "click the 'Load Report' button";
const SLOW_DELAY_MS = 6000;
const IDLE_GIVE_UP_MS = 14000;

interface VirtualPage {
  page: Page;
  clock: { now: number };
  signalCounter: { n: number };
  markActStarted: () => void;
  actStarted: () => boolean;
  /** Count of consecutive 1s settle polls issued right after the click. */
  settlePolls: () => number;
}

/** `lateAtMs` null models a click that never produces any DOM or network activity. */
function makeVirtualPage(lateAtMs: number | null): VirtualPage {
  const clock = { now: 0 };
  const signalCounter = { n: 0 };
  const changed = (): boolean => lateAtMs !== null && clock.now >= lateAtMs;
  let bumped = false;
  let actStarted = false;
  let settleDone = false;
  let settlePolls = 0;
  const page = {
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("outerHTML")) {
        return changed()
          ? { html: 9000, text: "2:report loaded with rows" }
          : { html: 1200, text: "1:report not loaded" };
      }
      if (src.includes("isInvalid")) return 0;
      return null;
    }),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: () => "https://app.example.com/reports",
    title: vi.fn().mockResolvedValue("Reports"),
    waitForTimeout: vi.fn().mockImplementation(async (ms: number) => {
      clock.now += ms;
      if (ms === 1000 && actStarted && !settleDone) settlePolls += 1;
      else if (settlePolls > 0) settleDone = true;
      if (changed() && !bumped) {
        bumped = true;
        signalCounter.n += 1;
      }
    }),
  } as unknown as Page;
  return {
    page,
    clock,
    signalCounter,
    markActStarted: () => {
      actStarted = true;
    },
    actStarted: () => actStarted,
    settlePolls: () => settlePolls,
  };
}

function baseParams(
  vp: VirtualPage,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    stagehand: {} as unknown as Stagehand,
    page: vp.page,
    step: STEP,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 0,
    totalSteps: () => 1,
    phase: "flow",
    signalCounter: vp.signalCounter,
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
    ...overrides,
  };
}

const CLICK_RESULT = {
  success: true,
  message: "clicked",
  actionDescription: "Load Report",
  actions: [{ selector: "css=button#load-report", description: "Load Report", method: "click" }],
};

describe("flow-runner/executeStepWithHealing — post-click settle (slow-transition acceptance)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardedObserve.mockResolvedValue([
      { selector: "css=button#load-report", description: "Load Report", method: "click" },
    ]);
  });

  it("verifies a click whose DOM change and network signal land ~6s late on attempt 1 via network", async () => {
    const vp = makeVirtualPage(SLOW_DELAY_MS);
    guardedAct.mockResolvedValue(CLICK_RESULT);
    const trajectory: { stepIndex: number; verifiedBy: string | null }[] = [];

    const outcome = await executeStepWithHealing(baseParams(vp, { trajectory }) as never);

    expect(outcome).toBe("completed");
    expect(guardedAct).toHaveBeenCalledTimes(1);
    expect(trajectory).toEqual([expect.objectContaining({ stepIndex: 0, verifiedBy: "network" })]);
  });

  it("a click with no activity still falls through after about the idle give-up window", async () => {
    const vp = makeVirtualPage(null);
    guardedAct.mockImplementation(async () => {
      vp.markActStarted();
      return CLICK_RESULT;
    });
    guardedObserve.mockImplementation(async () =>
      vp.actStarted()
        ? []
        : [{ selector: "css=button#load-report", description: "Load Report", method: "click" }]
    );

    await expect(executeStepWithHealing(baseParams(vp) as never)).rejects.toThrow(
      /verification|attempts/i
    );

    expect(guardedAct).toHaveBeenCalledTimes(1);
    expect(vp.settlePolls()).toBe(IDLE_GIVE_UP_MS / 1000);
  });
});
