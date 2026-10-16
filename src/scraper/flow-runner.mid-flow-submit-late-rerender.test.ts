import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerCentreHitTest } from "@/scraper/centre-hit-test-fake.test-helper";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * End-to-end guard through `executeStepWithHealing` for a submit-shaped click
 * on a mid-flow step: the header text flips right away but the body re-renders
 * ~8s later with no counted network signal. The settle wait must let the late
 * re-render land so a non-final step is credited, while a genuine no-op click
 * still ends as a phantom at the settle give-up and the final step keeps its
 * strict network/URL requirement. Time is a virtual clock advanced by the fake
 * page's `waitForTimeout`.
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

const STEP =
  "On the registration form (Email Address and Password already filled), click the Create Account button to submit the form";
const IDLE_GIVE_UP_MS = 14000;
const CANDIDATE = {
  selector: "css=button#create-account",
  description: "Create Account",
  method: "click",
};
const CLICK_RESULT = {
  success: true,
  message: "clicked",
  actionDescription: "Create Account",
  actions: [CANDIDATE],
};

interface VirtualPage {
  page: Page;
  signalCounter: { n: number };
  markActStarted: () => void;
  actStarted: () => boolean;
  settlePolls: () => number;
}

/** `lateRender` false models a click that never changes anything on the page. */
function makePage(lateRender: boolean): VirtualPage {
  const clock = { now: 0 };
  const signalCounter = { n: 0 };
  let clickedAt: number | null = null;
  let settlePolls = 0;
  let settleDone = false;
  const page = {
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      const centred = answerCentreHitTest(expr);
      if (centred) return centred;
      const src = String(expr);
      if (src.includes("outerHTML")) {
        const elapsed = clickedAt === null ? 0 : clock.now - clickedAt;
        if (!lateRender || clickedAt === null || elapsed < 2000) {
          return { html: 1200, text: "1:registration form" };
        }
        if (elapsed < 8000) return { html: 1300, text: "2:verify your account header" };
        return { html: 9000, text: "3:verify your account header and code entry body" };
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
    url: () => "https://app.example.com/register",
    title: vi.fn().mockResolvedValue("Register"),
    waitForTimeout: vi.fn().mockImplementation(async (ms: number) => {
      clock.now += ms;
      if (ms === 1000 && clickedAt !== null && !settleDone) settlePolls += 1;
      else if (settlePolls > 0) settleDone = true;
    }),
  } as unknown as Page;
  return {
    page,
    signalCounter,
    markActStarted: () => {
      clickedAt = clock.now;
    },
    actStarted: () => clickedAt !== null,
    settlePolls: () => settlePolls,
  };
}

function wireClick(vp: VirtualPage): void {
  guardedAct.mockImplementation(async () => {
    vp.markActStarted();
    return CLICK_RESULT;
  });
  guardedObserve.mockImplementation(async () => (vp.actStarted() ? [] : [CANDIDATE]));
}

function baseParams(vp: VirtualPage, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    stagehand: {} as unknown as Stagehand,
    page: vp.page,
    step: STEP,
    optional: false,
    upload: false,
    submitStep: true,
    stepIndex: 0,
    totalSteps: () => 2,
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

describe("flow-runner/executeStepWithHealing — mid-flow submit with a late re-render", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("credits a non-final submit-shaped click whose header flips at once and body re-renders ~8s later with no network", async () => {
    const vp = makePage(true);
    wireClick(vp);
    const trajectory: { stepIndex: number; verifiedBy: string | null }[] = [];

    const outcome = await executeStepWithHealing(
      baseParams(vp, { trajectory, isFinalStep: false }) as never
    );

    expect(outcome).toBe("completed");
    expect(guardedAct).toHaveBeenCalledTimes(1);
    expect(vp.signalCounter.n).toBe(0);
    expect(trajectory).toEqual([expect.objectContaining({ stepIndex: 0 })]);
  });

  it("classifies a genuine no-op click as a phantom at the settle idle give-up", async () => {
    const vp = makePage(false);
    wireClick(vp);

    await expect(
      executeStepWithHealing(baseParams(vp, { isFinalStep: false }) as never)
    ).rejects.toThrow(/verification|attempts/i);

    expect(guardedAct).toHaveBeenCalledTimes(1);
    expect(vp.settlePolls()).toBe(IDLE_GIVE_UP_MS / 1000);
  });

  it("does not credit the same DOM-only page on DOM alone when it is the final step", async () => {
    const vp = makePage(true);
    wireClick(vp);

    await expect(
      executeStepWithHealing(baseParams(vp, { isFinalStep: true, totalSteps: () => 1 }) as never)
    ).rejects.toThrow(/verification|attempts/i);

    expect(vp.signalCounter.n).toBe(0);
  });
});
