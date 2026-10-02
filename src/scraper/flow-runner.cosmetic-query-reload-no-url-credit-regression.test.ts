import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for the root-cause fix routing `urlChanged` through
 * `hasOriginOrPathChanged` (see `flow-runner.ts`'s `urlChanged =
 * hasOriginOrPathChanged(pre.url, post.url)`). Proves a non-submit,
 * non-advance click whose only post-click signal is a same-path,
 * cosmetic-query-only URL diff is NOT credited `verifiedBy: "url"` — the
 * exact shape of a mode-toggle click that bounces back to the same page with
 * a fresh transient query param (e.g. a cache-busting request id), rather
 * than a genuine navigation. A positive control on the same fixture family
 * (a real path change) proves the fix tightens the signal instead of
 * disabling it.
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

const TOGGLE_STEP = "click the toggle to switch to the registration view";

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
    step: TOGGLE_STEP,
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

describe("flow-runner/executeStepWithHealing — cosmetic same-path query reload is not credited verifiedBy=url", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardedObserve.mockResolvedValue([
      { selector: "css=a#toggle", description: "Toggle link", method: "click" },
    ]);
  });

  it("a same-path, cosmetic-query-only reload after a non-submit toggle click is NOT credited verifiedBy=url", async () => {
    const urls = { current: "https://example.com/login?session=abc" };
    guardedAct.mockImplementation(async () => {
      // Only a transient query param changes — same origin, same path.
      urls.current = "https://example.com/login?session=abc&clientRequestID=xyz-123";
      return {
        success: true,
        message: "clicked",
        actionDescription: "Toggle link",
        actions: [{ selector: "css=a#toggle", description: "Toggle link", method: "click" }],
      };
    });
    // No further candidates on retries — the step never finds another
    // actionable element, so if the cosmetic query diff is (correctly) not
    // credited as a url signal, the cascade exhausts its attempts and
    // rejects rather than silently completing.
    guardedObserve.mockResolvedValueOnce([
      { selector: "css=a#toggle", description: "Toggle link", method: "click" },
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

  it("positive control: a genuine path change on the same fixture family still credits verifiedBy=url", async () => {
    const urls = { current: "https://example.com/login?session=abc" };
    guardedAct.mockImplementation(async () => {
      urls.current = "https://example.com/register?session=abc";
      return {
        success: true,
        message: "clicked",
        actionDescription: "Toggle link",
        actions: [{ selector: "css=a#toggle", description: "Toggle link", method: "click" }],
      };
    });

    const outcome = await executeStepWithHealing(baseParams(urls) as never);

    expect(outcome).toBe("completed");
  });
});
