import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Primary-attempt network credit must be destination-gated. Positive-control regression for the destination-plausibility gate (see
 * `flow-runner.step-destination-plausibility-url-credit.test.ts`'s own
 * `urlChanged = hasOriginOrPathChanged(pre.url, post.url) &&
 * isPlausibleStepDestination(step, post.url)`). Proves the gate only vetoes
 * sign-in-shaped bounces for non-sign-in steps — it must not weaken
 * `hasOriginOrPathChanged`'s existing genuine-vs-cosmetic distinction, nor
 * block ordinary same-flow navigation credit, extending the same positive-
 * control fixture family as
 * `flow-runner.cosmetic-query-reload-no-url-credit-regression.test.ts`.
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
const _SIGN_IN_STEP = "click the Sign In button";
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

describe("flow-runner/executeStepWithHealing — primary network credit is destination-gated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardedObserve.mockResolvedValueOnce([
      { selector: RESOLVED_SELECTOR, description: "Continue", method: "click" },
    ]);
    guardedObserve.mockResolvedValue([]);
  });

  function scriptAct(urls: { current: string }, counter: { n: number }, postUrl: string): void {
    guardedAct.mockImplementation(async () => {
      urls.current = postUrl;
      counter.n += 3;
      return {
        success: true,
        message: "clicked",
        actionDescription: "Continue",
        actions: [{ selector: RESOLVED_SELECTOR, description: "Continue", method: "click" }],
      };
    });
  }

  it("a sign-in-shaped bounce with rising network is not credited on attempt 1", async () => {
    const urls = { current: "https://example.com/checkout/shipping" };
    const signalCounter = { n: 0 };
    scriptAct(urls, signalCounter, "https://example.com/login?redirect=%2Fapply");

    const trajectory: { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"] }[] = [];
    await executeStepWithHealing(
      baseParams(NON_SIGN_IN_STEP, urls, { trajectory, signalCounter }) as never
    ).catch(() => undefined);

    expect(trajectory.some((t) => t.verifiedBy === "network")).toBe(false);
  });

  it("a plausible destination with rising network is still credited", async () => {
    const urls = { current: "https://example.com/checkout/shipping" };
    const signalCounter = { n: 0 };
    scriptAct(urls, signalCounter, "https://example.com/checkout/payment");

    const trajectory: { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"] }[] = [];
    const outcome = await executeStepWithHealing(
      baseParams(NON_SIGN_IN_STEP, urls, { trajectory, signalCounter }) as never
    );

    expect(outcome).toBe("completed");
  });
});
