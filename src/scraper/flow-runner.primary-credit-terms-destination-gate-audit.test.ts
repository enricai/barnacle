import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { isPlausibleStepDestination } from "@/scraper/phantom-click";
import type { Logger } from "@/types/logging";

/**
 * Audit: every credit term in the primary `verified` expression (DOM state,
 * network, URL change, view-swap, form-value) must yield no credit when the
 * landed destination is implausible for the step.
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
  "Below the newly-revealed Email Address/Password sign-in form, under the text Don't have an account yet?, click the Create Account button to switch to account registration";
const SELECTOR = "css=input#confirm";

function fakePage(urls: { current: string }): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(true),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: () => urls.current,
    title: vi.fn().mockResolvedValue("App"),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

function baseParams(urls: { current: string }, trajectory: unknown[]): Record<string, unknown> {
  return {
    stagehand: {} as unknown as Stagehand,
    page: fakePage(urls),
    step: STEP,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 0,
    totalSteps: () => 1,
    phase: "flow",
    signalCounter: { n: 0 },
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
    trajectory,
  };
}

describe("flow-runner/executeStepWithHealing — primary credit terms are destination-gated", () => {
  const LANDED = "https://example.com/login?redirect=%2Fapply";

  beforeEach(() => {
    vi.clearAllMocks();
    guardedObserve.mockResolvedValueOnce([
      { selector: SELECTOR, description: "Create Account", method: "click" },
    ]);
    guardedObserve.mockResolvedValue([]);
  });

  it("vetoes the verbatim report instruction when landing on a sign-in-shaped URL", () => {
    expect(isPlausibleStepDestination(STEP, LANDED)).toBe(false);
  });

  it("grants no credit for a click that lands on the implausible destination", async () => {
    const urls = { current: "https://example.com/apply" };
    guardedAct.mockImplementation(async () => {
      urls.current = LANDED;
      return {
        success: true,
        message: "clicked",
        actionDescription: "Create Account",
        actions: [{ selector: SELECTOR, description: "Create Account", method: "click" }],
      };
    });
    const trajectory: { verifiedBy: string | null }[] = [];

    await executeStepWithHealing(baseParams(urls, trajectory) as never).catch(() => undefined);

    expect(trajectory.filter((t) => t.verifiedBy !== null)).toEqual([]);
  });
});
