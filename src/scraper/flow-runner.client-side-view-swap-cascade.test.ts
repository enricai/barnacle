import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import {
  type AttemptRecord,
  executeStepWithHealing,
  resetBillingErrorFlagForTests,
} from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Integration test for bugfix-001's click-view-swap verification gate.
 * Proves the root failure mode from the uchealth-8 bug report cannot recur:
 * once the gate credits a view-swap click (DOM grew ≥5KB, zero network) as
 * verified in attempt 2, the step returns "completed" before reaching
 * attempt 4 (observe-act-exclude), so the correct candidate is never added
 * to the excluded-selectors list and the decoy is never clicked.
 */

const guardedObserve = vi.fn();
const guardedAct = vi.fn();
const resolveFrameTarget = vi.fn();

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
    guardedAct: (...args: unknown[]) => guardedAct(...args),
  };
});

vi.mock("@/scraper/frame-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/frame-target")>();
  return {
    ...actual,
    resolveFrameTarget: (...args: unknown[]) => resolveFrameTarget(...args),
    waitForChildFrameReady: async () => undefined,
  };
});

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const FRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const VIEW_SWAP_BYTES_DELTA = 49518; // Measured from uchealth-8 run

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

/**
 * Child `FrameTarget` whose `evaluate` answers snapshotPage's `{html,text}`
 * probe. The `domState` ref lets the test simulate DOM growth on click —
 * the evaluate mock reads from `domState.current` each time.
 */
function makeChildFrameTarget(domState: { current: { html: number; text: string } }): FrameTarget {
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: FRAME_SELECTOR,
    evaluate: vi.fn().mockImplementation((expr: unknown) => {
      // Handle body.outerHTML probe (returns string or null)
      if (
        typeof expr === "string" &&
        expr.includes("document.body") &&
        expr.includes("outerHTML") &&
        !expr.includes("innerText")
      ) {
        return Promise.resolve("<body></body>");
      }
      // Handle snapshot probes (DOM_SNAPSHOT_EXPR) — returns {html, text}
      // The actual expression is:
      // `(() => { const b = document.body; if (!b) return { html: 0, text: "" }; const t = b.innerText || ""; return { html: (b.outerHTML || "").length, text: t.length + ":" + t.slice(0, 200) }; })()`
      if (typeof expr === "string" && (expr.includes("innerText") || expr.includes("(() =>"))) {
        return Promise.resolve({
          html: domState.current.html,
          text: domState.current.text,
        });
      }
      // Default: return null for any other expression
      return Promise.resolve(null);
    }),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: () => Promise.resolve("https://apply.talemetry.com/application/abc-123"),
    title: () => Promise.resolve("Apply"),
  };
}

/**
 * Builds a fake page whose deepLocator sees two candidates (correct button
 * and decoy), and whose sendCDP (the network capture seam) returns zero
 * requests. The `clickSpy` records which candidate was clicked, and the
 * `onClickCallback` is invoked when a click occurs (used to trigger snapshot state changes).
 */
function makeViewSwapPage(
  frame: FakeDeepLocatorFrame,
  clickSpy: { manualApplication: number; close: number },
  onClickCallback?: (index: number) => void
): Page {
  const fakeDeepLocator = makeFakeDeepLocator(frame);
  const wrappedDeepLocator = (selector: string) => {
    const delegate = fakeDeepLocator(selector);
    return {
      ...delegate,
      nth: (index: number) => {
        const inner = fakeDeepLocator(selector).nth(index);
        return {
          ...inner,
          click: async () => {
            await inner.click();
            if (index === 0) {
              clickSpy.manualApplication++;
            } else if (index === 1) {
              clickSpy.close++;
            }
            onClickCallback?.(index);
          },
        };
      },
    };
  };

  return {
    evaluate: vi.fn().mockResolvedValue(null),
    deepLocator: wrappedDeepLocator,
    url: () => "https://careers.uchealth.org/jobs/123/apply",
    title: vi.fn().mockResolvedValue("Apply"),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
    mainFrameId: () => "main",
    // Zero network requests — the view swap is purely client-side
    sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

describe("flow-runner click-view-swap cascade — correct candidate is never excluded after verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBillingErrorFlagForTests();
    // guardedObserve returns no candidates (the OOPIF condition that forces
    // the deepLocator fallback).
    guardedObserve.mockResolvedValue([]);
    guardedAct.mockResolvedValue({
      success: false,
      message: "no candidates",
      actionDescription: "",
      actions: [],
    });
  });

  it("clicking 'Manual Application' (which grows DOM +49KB with zero network) verifies in attempt 2 via view-swap gate, returns 'completed', and never clicks the 'Close' decoy", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const scopedHopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;

    // Two candidates: the correct "Manual Application" button (index 0) and
    // the decoy "Close" button (index 1). In the real uchealth-8 run,
    // attempt 2 clicked Manual Application, was wrongly scored as failure,
    // then attempt 4 excluded it and clicked Close instead.
    registerDeepLocatorHopElements(frame, scopedHopSelector, ["Manual Application", "Close"]);
    // The probe needs a candidate at the unscoped "*" hop to report "present"
    // before the cascade runs (see deep-locator-interactive-scope.test.ts).
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> *`, [
      "Manual Application",
      "Close",
    ]);

    // DOM state that changes on click. Start with 0 bytes (pre-click).
    const domState = { current: { html: 0, text: "0:" } };

    const clickSpy = { manualApplication: 0, close: 0 };
    const page = makeViewSwapPage(frame, clickSpy, (index) => {
      // When candidate 0 (Manual Application) is clicked, trigger DOM growth
      if (index === 0) {
        domState.current = {
          html: VIEW_SWAP_BYTES_DELTA,
          text: `${VIEW_SWAP_BYTES_DELTA}:`,
        };
      }
    });

    const frameTarget = makeChildFrameTarget(domState);
    resolveFrameTarget.mockResolvedValue(frameTarget);

    const attemptsByFailure: AttemptRecord[][] = [];

    const result = await executeStepWithHealing({
      stagehand: makeStagehand(),
      page,
      frameTarget,
      step: "Click the Manual Application button",
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
      logger: testLogger,
      resumeFixture: null,
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
      onStepFailure: ({ attempts }) => {
        attemptsByFailure.push(attempts);
        return null;
      },
    });

    // The step resolved as "completed" via the view-swap gate.
    expect(result).toBe("completed");

    // Attempt 2 clicked "Manual Application" and was verified via view-swap.
    expect(clickSpy.manualApplication).toBe(1);

    // The decoy "Close" button was never clicked — proof that attempt 4
    // (observe-act-exclude) never ran, because the step returned "completed"
    // in attempt 2.
    expect(clickSpy.close).toBe(0);

    // No failure was recorded (onStepFailure was never called).
    expect(attemptsByFailure.length).toBe(0);

    // Verify the attempt record shows view-swap verification.
    const infoLogs = (testLogger.info as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0]
    ) as string[];
    const healedLog = infoLogs.find((log) => log.includes("healed on attempt 2"));
    expect(healedLog).toBeDefined();
  });

  it("a click that produces <5KB DOM growth (below the view-swap threshold) does NOT verify via view-swap, and the cascade continues to attempt 4 which excludes the first candidate", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const scopedHopSelector = `${FRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;

    registerDeepLocatorHopElements(frame, scopedHopSelector, ["Manual Application", "Close"]);
    registerDeepLocatorHopElements(frame, `${FRAME_SELECTOR} >> *`, [
      "Manual Application",
      "Close",
    ]);

    // DOM state that changes slightly on click (below threshold).
    const domState = { current: { html: 0, text: "0:" } };

    const clickSpy = { manualApplication: 0, close: 0 };
    const page = makeViewSwapPage(frame, clickSpy, () => {
      // Any click produces only 2KB growth (below the 5KB threshold)
      domState.current = { html: 2000, text: "2000:" };
    });

    const frameTarget = makeChildFrameTarget(domState);
    resolveFrameTarget.mockResolvedValue(frameTarget);

    const attemptsByFailure: AttemptRecord[][] = [];

    await expect(
      executeStepWithHealing({
        stagehand: makeStagehand(),
        page,
        frameTarget,
        step: "Click the Manual Application button",
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
        logger: testLogger,
        resumeFixture: null,
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
        onStepFailure: ({ attempts }) => {
          attemptsByFailure.push(attempts);
          return null;
        },
      })
    ).rejects.toThrow(/failed verification after \d+ attempts/);

    // Both candidates were clicked: attempt 2 clicked "Manual Application",
    // attempt 4 excluded it and clicked "Close".
    expect(clickSpy.manualApplication).toBeGreaterThanOrEqual(1);
    expect(clickSpy.close).toBeGreaterThanOrEqual(1);

    // The failure dump was recorded.
    expect(attemptsByFailure.length).toBeGreaterThan(0);
    const attempts = attemptsByFailure[0] ?? [];

    // Attempt 2 (observe-act) clicked the first candidate but did NOT verify.
    const attempt2 = attempts.find((a) => a.attempt === 2);
    expect(attempt2?.technique).toBe("observe-act");
    expect(attempt2?.verifiedBy).toBeNull();

    // Attempt 4 (observe-act-exclude) ran and excluded the first candidate.
    const attempt4 = attempts.find((a) => a.attempt === 4);
    expect(attempt4?.technique).toBe("observe-act-exclude");
  });
});
