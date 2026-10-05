import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * End-to-end acceptance for the `destinationPlausible` wiring through
 * `executeStepWithHealing` itself — not just `isClickViewSwapVerified` in
 * isolation (see the sibling unit-level
 * `flow-runner.viewswap-destination-plausibility-veto-acceptance.test.ts`).
 * A click that produces a large zero-network DOM delta (the client-side
 * view-swap gate's own credit condition) but whose client-side route change
 * lands on a sign-in-shaped path, for a step whose instruction has nothing
 * to do with signing in, must NOT be credited — it bounced to an auth gate
 * rather than revealing the described content.
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

const REVEAL_STEP = "click the 'Show More Options' button to reveal additional settings";

/** DOM-snapshot `evaluate` expression contains `outerHTML`; the ng-invalid-marker probe's contains `isInvalid`. Everything else defaults to a no-op `null`. */
function fakePage(urls: { current: string }): Page {
  let snapshotCall = 0;
  return {
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("outerHTML")) {
        snapshotCall += 1;
        return snapshotCall === 1
          ? { html: 1200, text: "1:before" }
          : { html: 21200, text: "2:after, now showing additional settings" };
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
    step: REVEAL_STEP,
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

describe("flow-runner/executeStepWithHealing — destinationPlausible veto blocks a zero-network view-swap click that lands on a sign-in-shaped route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardedObserve.mockResolvedValue([
      { selector: "css=button#show-more", description: "Show More Options", method: "click" },
    ]);
  });

  it("a +20KB zero-network DOM delta that client-side-routes to /sign-in is NOT credited for a step that was never about signing in", async () => {
    const urls = { current: "https://app.example.com/settings" };
    guardedAct.mockImplementation(async () => {
      // Zero network, client-side route change — exactly the view-swap
      // gate's own credit condition — but the destination is sign-in-shaped.
      urls.current = "https://app.example.com/sign-in";
      return {
        success: true,
        message: "clicked",
        actionDescription: "Show More Options",
        actions: [
          { selector: "css=button#show-more", description: "Show More Options", method: "click" },
        ],
      };
    });
    // No further candidates on retries, so an incorrect credit is the only
    // way this resolves as "completed" — a vetoed attempt 1 exhausts the
    // cascade and rejects instead.
    guardedObserve.mockResolvedValueOnce([
      { selector: "css=button#show-more", description: "Show More Options", method: "click" },
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
    expect(attempt1?.verifiedBy).not.toBe("dom");
    expect(attempt1?.verifiedBy).not.toBe("url");
  });

  it("positive control: the same +20KB zero-network DOM delta is credited when it does NOT land on a sign-in-shaped route", async () => {
    const urls = { current: "https://app.example.com/settings" };
    guardedAct.mockImplementation(async () => {
      urls.current = "https://app.example.com/settings#expanded";
      return {
        success: true,
        message: "clicked",
        actionDescription: "Show More Options",
        actions: [
          { selector: "css=button#show-more", description: "Show More Options", method: "click" },
        ],
      };
    });

    const outcome = await executeStepWithHealing(baseParams(urls) as never);

    expect(outcome).toBe("completed");
  });
});
