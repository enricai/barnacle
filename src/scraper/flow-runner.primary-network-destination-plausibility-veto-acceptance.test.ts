import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Acceptance: a step that merely mentions sign-in as page context, with rising
 * network, must not be credited on the primary attempt when the page bounces
 * to a sign-in-shaped URL; steps that really target sign-in, and plausible
 * advances, keep their credit.
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

const REGISTRATION_STEP =
  'Below the sign-in form, under the text "Don\'t have an account yet?", click the "Create Account" button to switch to account registration';
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

describe("flow-runner/executeStepWithHealing — primary network credit destination veto", () => {
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

  async function run(
    step: string,
    postUrl: string
  ): Promise<{ verified: AttemptRecord["verifiedBy"][]; outcome: string | undefined }> {
    const urls = { current: "https://example.com/account" };
    const signalCounter = { n: 0 };
    scriptAct(urls, signalCounter, postUrl);
    const trajectory: { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"] }[] = [];
    const outcome = await executeStepWithHealing(
      baseParams(step, urls, { trajectory, signalCounter }) as never
    ).catch(() => undefined);
    return {
      verified: trajectory.map((t) => t.verifiedBy),
      outcome: outcome as string | undefined,
    };
  }

  it.each([
    "https://example.com/login?redirect=%2Fapply",
    "https://example.com/sign-in",
    "https://example.com/account/signin",
  ])("registration step bouncing to %s is not credited via network", async (landing) => {
    const { verified } = await run(REGISTRATION_STEP, landing);
    expect(verified).not.toContain("network");
    expect(verified).not.toContain("url");
  });

  it("a step targeting sign-in landing on /login with network is still credited", async () => {
    const { outcome } = await run(SIGN_IN_STEP, "https://example.com/login");
    expect(outcome).toBe("completed");
  });

  it("a plausible destination with network is still verified", async () => {
    const { outcome } = await run(REGISTRATION_STEP, "https://example.com/register");
    expect(outcome).toBe("completed");
  });
});
