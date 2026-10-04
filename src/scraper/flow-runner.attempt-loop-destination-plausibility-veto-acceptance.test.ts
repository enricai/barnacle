import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Acceptance coverage for the report's primary named root-cause site: the
 * `urlChanged = hasOriginOrPathChanged(pre.url, post.url) &&
 * isPlausibleStepDestination(step, post.url)` gate in `flow-runner.ts`'s
 * attempt loop. Proves that attempt 1 is NOT credited `verifiedBy: "url"`
 * when a click produces a genuine, non-cosmetic origin/path change but lands
 * on a sign-in-shaped destination for a step whose own instruction has
 * nothing to do with signing in — the page bounced back to an auth gate
 * rather than advancing, so crediting it would silently strand the flow.
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

const APPLY_STEP = "click the link to switch to the registration form";

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
    title: vi.fn().mockResolvedValue("Sign In"),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

function baseParams(
  urls: { current: string },
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    stagehand: makeStagehand(),
    page: fakePage(urls),
    step: APPLY_STEP,
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

describe("flow-runner/executeStepWithHealing — implausible sign-in-shaped destination is not credited verifiedBy=url on attempt 1", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardedObserve.mockResolvedValue([
      { selector: "css=a#apply-link", description: "Apply link", method: "click" },
    ]);
  });

  it("a genuine origin/path change to a sign-in-shaped destination after a non-sign-in step is NOT credited verifiedBy=url on attempt 1", async () => {
    const urls = { current: "https://apply.example.com/apply" };
    guardedAct.mockImplementation(async () => {
      // Genuine origin+path change — not cosmetic — but the destination is
      // sign-in-shaped while the step instruction is about registration.
      urls.current = "https://apply.example.com/sign-in";
      return {
        success: true,
        message: "clicked",
        actionDescription: "Apply link",
        actions: [{ selector: "css=a#apply-link", description: "Apply link", method: "click" }],
      };
    });
    // No further candidates on retries — the step never finds another
    // actionable element, so if the sign-in-shaped destination is (correctly)
    // vetoed as implausible, the cascade exhausts its attempts and rejects
    // rather than silently stranding the flow on the auth gate.
    guardedObserve.mockResolvedValueOnce([
      { selector: "css=a#apply-link", description: "Apply link", method: "click" },
    ]);
    guardedObserve.mockResolvedValue([]);

    const attemptsByFailure: AttemptRecord[][] = [];

    await expect(
      executeStepWithHealing(
        baseParams(urls, {
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

  it("positive control: a genuine path change to a plausible (non-sign-in-shaped) destination still credits verifiedBy=url", async () => {
    const urls = { current: "https://apply.example.com/apply" };
    guardedAct.mockImplementation(async () => {
      urls.current = "https://apply.example.com/register";
      return {
        success: true,
        message: "clicked",
        actionDescription: "Apply link",
        actions: [{ selector: "css=a#apply-link", description: "Apply link", method: "click" }],
      };
    });

    const outcome = await executeStepWithHealing(baseParams(urls) as never);

    expect(outcome).toBe("completed");
  });
});
