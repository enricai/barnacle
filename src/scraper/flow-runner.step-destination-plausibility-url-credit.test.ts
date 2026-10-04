import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for bugfix-002: the primary attempt-loop `urlChanged`
 * and the n+16 `retryUrlChanged` sibling must AND `hasOriginOrPathChanged`
 * with `isPlausibleStepDestination(step, postUrl)`, so a genuine origin/path
 * change is only credited `verifiedBy: "url"` when the landed destination
 * plausibly corroborates the step's own instruction. A step that is NOT
 * sign-in-shaped (e.g. "confirm shipping address") whose click bounces to a
 * sign-in-shaped path must NOT be credited — the page bounced back to an
 * auth gate rather than advancing. A positive control (the step itself IS
 * sign-in-shaped) proves the fix doesn't over-correct genuine sign-in
 * navigations.
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

const NON_SIGN_IN_STEP = "confirm the shipping address and continue";
const SIGN_IN_STEP = "click the Sign In button";
const RESOLVED_SELECTOR = "css=button#continue";

/** Fake `Page` whose `url()` reads from a mutable holder so a scenario can script the pre/post snapshot pair. */
function fakePage(urls: { current: string }): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: () => urls.current,
    title: vi.fn().mockResolvedValue("App"),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

function baseParams(
  step: string,
  urls: { current: string },
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    stagehand: makeStagehand(),
    page: fakePage(urls),
    step,
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
    ...overrides,
  };
}

describe("flow-runner/executeStepWithHealing — primary-loop urlChanged is gated by destination plausibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardedObserve.mockResolvedValueOnce([
      { selector: RESOLVED_SELECTOR, description: "Continue", method: "click" },
    ]);
    guardedObserve.mockResolvedValue([]);
  });

  it("a non-sign-in-shaped step whose click bounces to a sign-in-shaped path is NOT credited verifiedBy=url", async () => {
    const urls = { current: "https://example.com/checkout/shipping" };
    guardedAct.mockImplementation(async () => {
      urls.current = "https://example.com/login";
      return {
        success: true,
        message: "clicked",
        actionDescription: "Continue",
        actions: [{ selector: RESOLVED_SELECTOR, description: "Continue", method: "click" }],
      };
    });

    const attemptsByFailure: AttemptRecord[][] = [];

    await expect(
      executeStepWithHealing(
        baseParams(NON_SIGN_IN_STEP, urls, {
          onStepFailure: ({ attempts }: { attempts: AttemptRecord[] }) => {
            attemptsByFailure.push(attempts);
            return null;
          },
        }) as never
      )
    ).rejects.toThrow(/verification|attempts/i);

    expect(attemptsByFailure.length).toBeGreaterThan(0);
    const attempt1 = (attemptsByFailure[0] ?? []).find((a) => a.attempt === 1);
    expect(attempt1).toBeDefined();
    expect(attempt1?.verifiedBy).not.toBe("url");
  });

  it("positive control: a sign-in-shaped step landing on a sign-in-shaped path IS credited verifiedBy=url", async () => {
    const urls = { current: "https://example.com/checkout/shipping" };
    guardedAct.mockImplementation(async () => {
      urls.current = "https://example.com/login";
      return {
        success: true,
        message: "clicked",
        actionDescription: "Sign In",
        actions: [{ selector: RESOLVED_SELECTOR, description: "Sign In", method: "click" }],
      };
    });

    const outcome = await executeStepWithHealing(baseParams(SIGN_IN_STEP, urls) as never);

    expect(outcome).toBe("completed");
  });

  it("positive control: a non-sign-in-shaped step landing on a non-sign-in path IS credited verifiedBy=url", async () => {
    const urls = { current: "https://example.com/checkout/shipping" };
    guardedAct.mockImplementation(async () => {
      urls.current = "https://example.com/checkout/payment";
      return {
        success: true,
        message: "clicked",
        actionDescription: "Continue",
        actions: [{ selector: RESOLVED_SELECTOR, description: "Continue", method: "click" }],
      };
    });

    const outcome = await executeStepWithHealing(baseParams(NON_SIGN_IN_STEP, urls) as never);

    expect(outcome).toBe("completed");
  });
});

describe("flow-runner/executeStepWithHealing — n+16 fallback retryUrlChanged is gated by destination plausibility", () => {
  function fakeN16Page(urls: { current: string }, clickTargetUrl: string): Page {
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("XPathResult.FIRST_ORDERED_NODE_TYPE") && src.includes('kind: "click"')) {
        urls.current = clickTargetUrl;
        return { fired: true, kind: "click" };
      }
      return null;
    });

    return {
      evaluate,
      url: () => urls.current,
      title: vi.fn().mockResolvedValue("App"),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          click: vi.fn().mockResolvedValue(undefined),
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;
  }

  function n16Params(
    step: string,
    page: Page,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      stagehand: makeStagehand(),
      page,
      step,
      optional: false,
      upload: false,
      submitStep: true,
      stepIndex: 0,
      totalSteps: () => 1,
      isFinalStep: true,
      phase: "flow",
      signalCounter: { n: 0 },
      recentCaptures: [],
      recentCaptureMeta: [],
      anthropic: null,
      rephraseModel: null,
      logger: testLogger,
      uploadFixture: null,
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

  const RESOLVED_XPATH_SELECTOR = "xpath=/html[1]/body[1]/div[1]/button[1]";

  beforeEach(() => {
    vi.clearAllMocks();
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "Continue",
      actions: [{ selector: RESOLVED_XPATH_SELECTOR, description: "Continue", method: "click" }],
    });
    guardedObserve.mockImplementation(async (_stagehand: unknown, instruction?: unknown) =>
      typeof instruction === "string"
        ? [{ selector: RESOLVED_XPATH_SELECTOR, description: "Continue", method: "click" }]
        : []
    );
  });

  it("a non-sign-in-shaped step whose n+16 fallback click bounces to a sign-in-shaped path is NOT credited verifiedBy=url", async () => {
    const urls = { current: "https://example.com/checkout/shipping" };
    const page = fakeN16Page(urls, "https://example.com/login");
    const attemptsByFailure: AttemptRecord[][] = [];

    await expect(
      executeStepWithHealing(
        n16Params(NON_SIGN_IN_STEP, page, {
          onStepFailure: ({ attempts }: { attempts: AttemptRecord[] }) => {
            attemptsByFailure.push(attempts);
            return null;
          },
        }) as never
      )
    ).rejects.toThrow(/verification|attempts|no candidates/i);

    expect(attemptsByFailure.length).toBeGreaterThan(0);
    const attempt1 = (attemptsByFailure[0] ?? []).find((a) => a.attempt === 1);
    expect(attempt1).toBeDefined();
    expect(attempt1?.verifiedBy).not.toBe("url");
  });
});
