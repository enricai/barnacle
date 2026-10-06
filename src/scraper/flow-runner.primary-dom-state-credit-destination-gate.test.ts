import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Primary-attempt DOM element-state credit (a toggled checkbox read back via
 * `verifyDomEffect`) must be destination-gated: a flip that lands on a
 * sign-in-shaped bounce is not evidence the step worked.
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

describe("flow-runner/executeStepWithHealing — primary DOM-state credit is destination-gated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardedObserve.mockResolvedValueOnce([
      { selector: SELECTOR, description: "Confirm", method: "check" },
    ]);
    guardedObserve.mockResolvedValue([]);
  });

  function scriptAct(urls: { current: string }, postUrl: string): void {
    guardedAct.mockImplementation(async () => {
      urls.current = postUrl;
      return {
        success: true,
        message: "checked",
        actionDescription: "Confirm",
        actions: [{ selector: SELECTOR, description: "Confirm", method: "check" }],
      };
    });
  }

  it("a DOM-only state flip on a sign-in-shaped page with no URL change is not credited as dom", async () => {
    const urls = { current: "https://example.com/login?redirect=%2Fapply" };
    scriptAct(urls, "https://example.com/login?redirect=%2Fapply");
    const trajectory: { verifiedBy: string | null }[] = [];

    await executeStepWithHealing(baseParams(urls, trajectory) as never).catch(() => undefined);

    expect(trajectory.some((t) => t.verifiedBy === "dom")).toBe(false);
  });

  it("a DOM-only state flip on a plausible destination is still credited", async () => {
    const urls = { current: "https://example.com/checkout/shipping" };
    scriptAct(urls, "https://example.com/checkout/shipping");

    const outcome = await executeStepWithHealing(baseParams(urls, []) as never);

    expect(outcome).toBe("completed");
  });
});
