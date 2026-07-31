import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for the submit-verification region of
 * `executeStepWithHealing`: the six `frameTarget ?? mainFrameTarget(page)`
 * call sites gated behind submit verification (top-level
 * `countNgInvalidContainers`, the n+16 replan-retry's `snapshotPage` +
 * `countNgInvalidContainers` (twice), `extractLivePageFormEvidence`, and the
 * post-attempt-1 `countNgInvalidContainers`) must thread the SAME resolved
 * `FrameTarget` object a caller passes in, not silently fall back to a
 * `mainFrameTarget(page)` bound to the wrong document for a cross-origin
 * iframe wizard.
 *
 * Distinct from `flow-runner.frame-primitive-helpers.test.ts` (unit-tests the
 * DOM primitives directly, doesn't drive the cascade) and
 * `flow-runner.frame-threading.test.ts` (covers the pre-submit region of the
 * cascade). Mocks `@/scraper/frame-target` and `@/scraper/stagehand-guard` at
 * the module boundary (same style as `flow-runner.frame-threading.test.ts`)
 * plus `@/lib/llm/judges/verify-submit`, so assertions are about WHICH
 * `FrameTarget` object crosses each call boundary, not about
 * `resolveFrameTarget`'s own origin-matching or the Haiku judge's reasoning.
 */

const resolveFrameTarget = vi.fn();
const mainFrameTarget = vi.fn();
const guardedObserve = vi.fn();
const guardedAct = vi.fn();
const verifySubmitWithLLM = vi.fn();

vi.mock("@/scraper/frame-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/frame-target")>();
  return {
    ...actual,
    resolveFrameTarget: (...args: unknown[]) => resolveFrameTarget(...args),
    mainFrameTarget: (...args: unknown[]) => mainFrameTarget(...args),
  };
});

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
    guardedAct: (...args: unknown[]) => guardedAct(...args),
  };
});

vi.mock("@/lib/llm/judges/verify-submit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/judges/verify-submit")>();
  return {
    ...actual,
    verifySubmitWithLLM: (...args: unknown[]) => verifySubmitWithLLM(...args),
  };
});

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const CHILD_ORIGIN = "https://apply.talemetry.com";
const FRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const SUBMIT_STEP = "Click the Submit button";

/**
 * Builds a main-frame `FrameTarget` delegating straight to `page`, matching
 * `mainFrameTarget`'s real contract — this is the fallback half of every
 * `frameTarget ?? mainFrameTarget(page)` shim, deliberately a DISTINCT
 * object from `childTarget` so a call landing on it (instead of the resolved
 * child) is detectable via `toBe`.
 */
function delegatingMainFrameTarget(page: Page): FrameTarget {
  return {
    frame: null,
    frameSelector: null,
    evaluate: (pageFunctionOrExpression, arg) => page.evaluate(pageFunctionOrExpression, arg),
    locator: (selector) => page.locator(selector),
    url: () => Promise.resolve(page.url()),
    title: () => page.title(),
  };
}

/**
 * A resolved child `FrameTarget` whose `evaluate` discriminates on the
 * expression string, so a single mock can back every DOM-direct probe the
 * submit-verify region issues (`snapshotPage`'s DOM_SNAPSHOT_EXPR,
 * `countNgInvalidContainers`'s marker-count expr, the n+16 click/ancestor
 * exprs, the submitted-state selector probe, `extractLivePageFormEvidence`'s
 * outerHTML read + leaf-invalid/interactive-target probes,
 * `probeFormValidityBeforeSubmit`'s FORM_VALIDITY_PROBE_EXPR). `invalidCount`
 * is mutable so a scenario can flip the marker count mid-attempt (pre-submit
 * baseline vs. post-attempt read).
 */
function makeChildTarget(
  urls: { current: string },
  opts: { invalidCount: () => number; n16ClickResult: () => Record<string, unknown> }
): FrameTarget {
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("outerHTML") && src.includes("innerText")) {
      return { html: 0, text: "0:" };
    }
    if (src.includes("document.body ? document.body.outerHTML : null")) {
      return null;
    }
    if (src.includes("MARKERS")) {
      // FORM_VALIDITY_PROBE_EXPR: pre-submit form-validity probe. No
      // pre-existing invalid controls to surface for these scenarios.
      return [];
    }
    if (src.includes('querySelectorAll("[class],[aria-invalid]")')) {
      // countNgInvalidContainers's marker-count expr.
      return opts.invalidCount();
    }
    if (src.includes('el.click !== "function"')) {
      // n+16's native-click fallback expr.
      return opts.n16ClickResult();
    }
    if (src.includes("XPathResult.FIRST_ORDERED_NODE_TYPE") && src.includes("el.type || null")) {
      // verifyDomEffect's click-branch inputType probe: never a radio/checkbox
      // here, so verifyDomEffect falls back to the network/URL signal.
      return null;
    }
    if (src.includes("isInvalid(node)")) {
      // n+16's ancestor-still-invalid probe (checkbox vacuous-click guard).
      return false;
    }
    if (src === "location.href") {
      return urls.current;
    }
    // submitted-state DOM selector probe, leaf-invalid-container probe,
    // interactive-targets-near-invalid probe: no matches for these fixtures.
    return null;
  });
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: FRAME_SELECTOR,
    evaluate: evaluate as FrameTarget["evaluate"],
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }) as unknown as FrameTarget["locator"],
    url: () => Promise.resolve(urls.current),
    title: () => Promise.resolve("Apply"),
  };
}

/** Fake `Page`: only the surface `executeStepWithHealing`'s non-frame-scoped calls touch (page.title(), page.waitForTimeout()). Its `evaluate`/`locator` must never fire — every probe in this region is frame-scoped. */
function fakePage(getUrl: () => string = () => `${CHILD_ORIGIN}/application/abc-123`): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: getUrl,
    title: vi.fn().mockResolvedValue("Apply"),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

/** Shared params every scenario passes to `executeStepWithHealing`; each test overrides only what its path needs. */
function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    stagehand: makeStagehand(),
    page: fakePage(),
    step: SUBMIT_STEP,
    optional: false,
    upload: false,
    submitStep: true,
    stepIndex: 0,
    totalSteps: () => 1,
    phase: "flow",
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: null,
    logger: testLogger,
    resumeFixture: null,
    isFinalStep: true,
    submitEndpointPattern: "/gq",
    submittedStateSelectors: ["uapp-universal-submitted-page"],
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

describe("flow-runner/executeStepWithHealing — submit-verify frame scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mainFrameTarget.mockImplementation(delegatingMainFrameTarget);
    // probeStepBeforeAttempts requires at least one candidate (focused or
    // unfocused) or the step is treated as absent before the cascade ever
    // runs. Every scenario below overrides this per-attempt as needed.
    guardedObserve.mockResolvedValue([
      { selector: "css=button#submit", description: "Submit button", method: "click" },
    ]);
  });

  it("threads the resolved child FrameTarget into the top-level submit verify (countNgInvalidContainers, submitted-state probe, verifySubmitWithLLM input)", async () => {
    const urls = { current: `${CHILD_ORIGIN}/application/abc-123` };
    const childTarget = makeChildTarget(urls, {
      invalidCount: () => 3,
      n16ClickResult: () => ({ fired: false }),
    });
    resolveFrameTarget.mockResolvedValue(childTarget);
    // Attempt 1's act resolves a click and flips the child frame's URL —
    // urlChanged verifies the step immediately, so the top-level (not the
    // n+16) submit-verify branch runs.
    guardedAct.mockImplementation(async () => {
      urls.current = `${CHILD_ORIGIN}/application/abc-123/thank-you`;
      return {
        success: true,
        message: "clicked",
        actionDescription: "Submit button",
        actions: [{ selector: "css=button#submit", description: "Submit button", method: "click" }],
      };
    });
    verifySubmitWithLLM.mockResolvedValue({
      verified: true,
      reason: null,
      dom_signal: null,
      url_signal: "/thank-you",
      rationale: "URL transitioned to the thank-you page",
    });

    const outcome = await executeStepWithHealing(baseParams({ frameTarget: childTarget }) as never);

    expect(outcome).toBe("completed");
    expect(mainFrameTarget).not.toHaveBeenCalled();

    // countNgInvalidContainers's marker-count evaluate call reached the
    // resolved child target, never page.evaluate.
    expect(childTarget.evaluate).toHaveBeenCalled();

    expect(verifySubmitWithLLM).toHaveBeenCalledTimes(1);
    expect(verifySubmitWithLLM).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ invalidMarkerCount: 3 }) })
    );
  });

  it("threads the resolved child FrameTarget into the n+16 replan-retry submit verify (retry snapshotPage, clickWasDomOnly countNgInvalidContainers, and the retry-verified countNgInvalidContainers feeding verifySubmitWithLLM)", async () => {
    const urls = { current: `${CHILD_ORIGIN}/application/abc-123` };
    // Attempt 1's resolved action carries an xpath= selector (required for
    // the n+16 fallback's `xpathBody` gate to arm) but verifyDomEffect's own
    // click-branch inputType probe resolves null (not a radio/checkbox), so
    // attempt 1 itself does NOT verify (no network/url/dom signal) — the
    // cascade falls into the n+16 el.click() fallback.
    const childTarget = makeChildTarget(urls, {
      invalidCount: () => 0,
      // n+16 resolves a plain (non-checkbox) click. No network/url delta on
      // its own, but the retry snapshot's html-length grows (a validation
      // re-render), which combined with invalidCount()===0 (not blocked)
      // verifies the retry and arms the requireSubmitEndpoint judge gate.
      n16ClickResult: () => ({ fired: true, kind: "click" }),
    });
    resolveFrameTarget.mockResolvedValue(childTarget);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "Submit button",
      actions: [
        { selector: "xpath=//button[@id='submit']", description: "Submit button", method: "click" },
      ],
    });
    // The attempt-1 `pre` snapshot (DOM_SNAPSHOT_EXPR) is the first
    // snapshot-shaped evaluate call; every snapshot after it (the
    // post-attempt-1 snapshot, then the n+16 retry snapshot) reports a
    // bigger body, so the retry snapshot's `retryHtmlDelta` (computed
    // against `pre`, not the intervening post) is nonzero.
    let snapshotCallCount = 0;
    const originalEvaluate = childTarget.evaluate;
    childTarget.evaluate = vi.fn().mockImplementation(async (expr: string) => {
      if (expr.includes("outerHTML") && expr.includes("innerText")) {
        snapshotCallCount += 1;
        return snapshotCallCount <= 1 ? { html: 0, text: "0:" } : { html: 500, text: "1:x" };
      }
      return originalEvaluate(expr);
    }) as FrameTarget["evaluate"];
    verifySubmitWithLLM.mockResolvedValue({
      verified: true,
      reason: null,
      dom_signal: null,
      url_signal: null,
      rationale: "DOM grew into a submitted state",
    });

    const outcome = await executeStepWithHealing(baseParams({ frameTarget: childTarget }) as never);

    expect(outcome).toBe("completed");
    expect(mainFrameTarget).not.toHaveBeenCalled();
    expect(verifySubmitWithLLM).toHaveBeenCalledTimes(1);
    // invalidMarkerCount reaching the judge is the child-frame count (0, per
    // opts.invalidCount), proving both the clickWasDomOnly gate's
    // countNgInvalidContainers call AND the retry-verified
    // countNgInvalidContainers call read the child frame, not the top frame.
    expect(verifySubmitWithLLM).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ invalidMarkerCount: 0 }) })
    );
  });

  it("threads the resolved child FrameTarget into extractLivePageFormEvidence and the post-attempt-1 invalid count when the submit click fails to verify at all", async () => {
    const urls = { current: `${CHILD_ORIGIN}/application/abc-123` };
    const childTarget = makeChildTarget(urls, {
      invalidCount: () => 2,
      // n+16's native click never fires (no matching element) — falls
      // through without verifying, so the cascade reaches the bottom of the
      // attempt-1 body (extractLivePageFormEvidence + postAttemptInvalidCount).
      n16ClickResult: () => ({ fired: false }),
    });
    resolveFrameTarget.mockResolvedValue(childTarget);
    // probeStepBeforeAttempts (before the attempt loop) needs one candidate
    // so the step isn't skipped as absent; every observe/act inside the
    // attempt loop itself finds nothing actionable — attempt 1 resolves a
    // click via guardedAct (so resolvedMethod === "click" and the
    // extractLivePageFormEvidence gate arms), attempts 2-5 fast-skip on
    // empty observe results.
    guardedObserve
      .mockResolvedValueOnce([
        { selector: "css=button#submit", description: "Submit button", method: "click" },
      ])
      .mockResolvedValue([]);
    guardedAct.mockResolvedValueOnce({
      success: true,
      message: "clicked",
      actionDescription: "Submit button",
      actions: [{ selector: "css=button#submit", description: "Submit button", method: "click" }],
    });

    await expect(
      executeStepWithHealing(baseParams({ frameTarget: childTarget }) as never)
    ).rejects.toThrow(/verification|attempts/i);

    expect(mainFrameTarget).not.toHaveBeenCalled();
    // extractLivePageFormEvidence's outerHTML read and the post-attempt-1
    // countNgInvalidContainers call both went through the child target.
    const evaluateCalls = (childTarget.evaluate as ReturnType<typeof vi.fn>).mock.calls as [
      string,
    ][];
    const outerHtmlCalls = evaluateCalls.filter(([expr]) =>
      expr.includes("document.body ? document.body.outerHTML : null")
    );
    expect(outerHtmlCalls.length).toBeGreaterThan(0);
    const invalidCountCalls = evaluateCalls.filter(([expr]) =>
      expr.includes('querySelectorAll("[class],[aria-invalid]")')
    );
    expect(invalidCountCalls.length).toBeGreaterThan(0);
  });

  it("main-frame control: frame: null behavior is unchanged — mainFrameTarget(page) is used and page.evaluate (not a resolved child target) receives the submit-verify probes", async () => {
    const urls = { current: `${CHILD_ORIGIN}/application/abc-123` };
    const page = fakePage(() => urls.current);
    const mainTarget = delegatingMainFrameTarget(page);
    resolveFrameTarget.mockResolvedValue(mainTarget);
    guardedAct.mockImplementation(async () => {
      urls.current = `${CHILD_ORIGIN}/application/abc-123/thank-you`;
      return {
        success: true,
        message: "clicked",
        actionDescription: "Submit button",
        actions: [{ selector: "css=button#submit", description: "Submit button", method: "click" }],
      };
    });
    verifySubmitWithLLM.mockResolvedValue({
      verified: true,
      reason: null,
      dom_signal: "uapp-universal-submitted-page",
      url_signal: null,
      rationale: "submitted-state DOM marker present",
    });
    (page.evaluate as ReturnType<typeof vi.fn>).mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes('querySelectorAll("[class],[aria-invalid]")')) return 0;
      return null;
    });

    const outcome = await executeStepWithHealing(
      baseParams({ page, frameTarget: undefined }) as never
    );

    expect(outcome).toBe("completed");
    expect(mainFrameTarget).toHaveBeenCalledWith(page);
    expect(page.evaluate).toHaveBeenCalled();
    expect(verifySubmitWithLLM).toHaveBeenCalledTimes(1);
    expect(verifySubmitWithLLM).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ invalidMarkerCount: 0 }) })
    );
  });
});
