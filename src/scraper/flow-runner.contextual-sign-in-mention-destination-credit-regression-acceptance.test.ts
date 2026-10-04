import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Acceptance coverage for the chokepoint fix in `isPlausibleStepDestination`
 * (phantom-click.ts), proven at its real consumer call sites in
 * flow-runner.ts's attempt loop (`urlChanged` / `classifyPhantomClick`).
 * Before the fix, `isPlausibleStepDestination` matched `SIGN_IN_PATTERNS`
 * against the step's whole whitespace-normalized instruction, so a step
 * whose own action was unrelated but whose surrounding descriptive clause
 * merely mentioned "sign-in" was wrongly treated as plausible and credited
 * `verifiedBy: "url"` after landing on a sign-in-shaped destination. This
 * test drives that exact shape through the real flow-runner call sites,
 * with zero edits to flow-runner.ts itself, to prove the fix's consumer
 * sites inherit it correctly.
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

const APPLY_STEP =
  "click the link to switch to account settings, near the sign-in confirmation banner";

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

describe("flow-runner/executeStepWithHealing — a contextual sign-in mention in a descriptive clause does not credit a sign-in-shaped destination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardedObserve.mockResolvedValue([
      { selector: "css=a#settings-link", description: "Settings link", method: "click" },
    ]);
  });

  it("a genuine origin/path change to a sign-in-shaped destination after a step whose action clause is unrelated (sign-in is only mentioned in a descriptive clause) is NOT credited verifiedBy=url on attempt 1", async () => {
    const urls = { current: "https://account.example.com/settings" };
    guardedAct.mockImplementation(async () => {
      // Genuine origin+path change — not cosmetic — but the destination is
      // sign-in-shaped while the step's own action clause is about account
      // settings; "sign-in" only appears in the surrounding descriptive
      // clause, which must not be credited as the step's own action.
      urls.current = "https://account.example.com/sign-in";
      return {
        success: true,
        message: "clicked",
        actionDescription: "Settings link",
        actions: [
          { selector: "css=a#settings-link", description: "Settings link", method: "click" },
        ],
      };
    });
    // No further candidates on retries — the step never finds another
    // actionable element, so if the sign-in-shaped destination is (correctly)
    // vetoed as implausible, the cascade exhausts its attempts and rejects
    // rather than silently stranding the flow on the auth gate.
    guardedObserve.mockResolvedValueOnce([
      { selector: "css=a#settings-link", description: "Settings link", method: "click" },
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
});
