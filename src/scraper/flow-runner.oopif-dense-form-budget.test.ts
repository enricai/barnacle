import { beforeEach, describe, expect, it, vi } from "vitest";

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({
  getLogger: () => loggerStub,
  getScriptLogger: () => loggerStub,
}));

import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  makeFakeFrameScan,
  NODE_NOT_ACTIONABLE_MESSAGE,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";
import {
  buildScanFrameCandidatesExpr,
  INTERACTIVE_CANDIDATE_SELECTOR,
} from "@/scraper/deep-locator-scan";
import { runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Acceptance-shaped regression pin for the exact uchealth-7 failure shape:
 * `#talemetry_apply_iframe >> *` resolves 371 in-frame candidates, one of
 * which is a hidden/zero-box element whose text collides with the rendered
 * control's, and the step must still click the rendered "Manual Application"
 * button — via one frame-scoped scan, not N per-candidate round-trips, and
 * without ever being defeated by an unrendered candidate's `-32000 Node does
 * not have a layout object` click rejection. Unlike
 * `deep-locator-candidates.test.ts`'s resolver-level suite (which passes a
 * pre-resolved `FrameTarget` directly, bypassing `resolveFrameTarget`) and
 * `flow-runner.oopif-candidate-ranking.test.ts` (whose fake child frame only
 * answers `location.href`, so its batched scan always fails over to the
 * legacy loop), this file drives the REAL `runHealingFlow` /
 * `resolveFrameTarget` / `resolveDeepLocatorCandidates` stack end to end —
 * scan, resolve, rank, walk, click — over a fake child frame whose
 * `evaluate` actually answers the batched-scan expression, so the whole path
 * the uchealth-7 bug report exercised is on trial, not one seam of it.
 */

const TOP_ORIGIN = "https://careers.uchealth.org";
const CHILD_ORIGIN = "https://apply.talemetry.com";
const IFRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123`;
/** The cascade's actual hop (`flow-runner.ts` scopes the observe-act fallback to `INTERACTIVE_CANDIDATE_SELECTOR`, not `"*"`) — must match so the fake's registered elements resolve at the same selector the cascade clicks through. */
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
/** The exact evaluate expression `resolveDeepLocatorCandidates` issues for the cascade's interactive-scoped hop — matched verbatim so the fake can route it to the scan (and anything else, e.g. an unrelated body-dump probe, to `null`). */
const SCAN_EXPR = buildScanFrameCandidatesExpr(INTERACTIVE_CANDIDATE_SELECTOR);

/** Verbatim step instruction from the bug report's flow. */
const MANUAL_APPLICATION_STEP =
  "In the application widget, click the 'Manual Application' button to skip the resume-upload flow entirely. Do NOT click 'Upload a Resume/CV', 'Use LinkedIn Profile', 'Upload From Dropbox', or 'Upload From OneDrive'.";

/** Matches the uchealth-7 bug report's measured candidate count for `#talemetry_apply_iframe >> *`. */
const TOTAL_CANDIDATES = 371;

const RENDERED_TARGET_TEXT = "Manual Application";

const testLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/**
 * Fake Stagehand whose `observe()` returns a single dummy candidate on its
 * FIRST call only, then `[]` (blind to the OOPIF) on every call after —
 * `act()` always reports no actionable candidate, forcing attempt 1 to fail
 * and the cascade into attempt 2's observe-act branch, the one that owns the
 * `resolveDeepLocatorCandidates` walk under test. The first-call exception
 * satisfies `probeStepBeforeAttempts`'s focused-observe reachability check
 * (`flow-runner.ts:5230-5237`) so the probe returns "present" from its OWN
 * observe result instead of falling through to its own, unrelated,
 * always-one-evaluate `resolveDeepLocatorCandidates` probe
 * (`flow-runner.ts:5262-5277` — bugfix-005's investigation notes call this a
 * deliberate asymmetry, not part of what this file pins) — isolating the
 * frame-evaluate count this test asserts to the cascade's own resolution.
 */
function makeFakeStagehandObserveOnceThenBlind() {
  let observeCalls = 0;
  return {
    act: async () => ({
      success: false,
      message: "no actionable candidate",
      actionDescription: MANUAL_APPLICATION_STEP,
      actions: [],
    }),
    observe: async () => {
      observeCalls += 1;
      if (observeCalls === 1) {
        return [{ selector: "xpath=//probe-presence", description: "probe-presence" }];
      }
      return [];
    },
  } as unknown as import("@browserbasehq/stagehand").Stagehand;
}

/**
 * Minimal fake `Frame`: `location.href` backs onto its own mutable ref (so a
 * click inside the iframe navigates the iframe, giving the cascade's
 * frame-scoped `urlChanged` verification a genuine reason to fire) and the
 * exact batched-scan expression (`SCAN_EXPR`) routes to
 * `makeFakeFrameScan`, wrapped in a spy so the test can assert the scan ran
 * exactly once. Any other expression (e.g. an unrelated body-dump probe)
 * returns `null`, matching `flow-runner.oopif-candidate-ranking.test.ts`'s
 * fixture — the rest of the runner already tolerates that.
 */
function makeFakeChildFrame(
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame
) {
  const scan = makeFakeFrameScan(deepLocatorFrame, HOP_SELECTOR);
  const scanSpy = vi.fn(scan);
  return {
    frame: {
      evaluate: async (expr: unknown) => {
        if (expr === "location.href") return childUrls.current;
        if (expr === SCAN_EXPR) return scanSpy();
        return null;
      },
      locator: () => ({
        first: () => ({
          isChecked: async () => false,
          inputValue: async () => "",
        }),
      }),
    },
    scanSpy,
  };
}

/**
 * Fake two-frame `Page` mirroring `flow-runner.oopif-candidate-ranking.test.
 * ts`'s fixture, extended with: (a) a child frame whose `evaluate` actually
 * answers the batched-scan expression (via {@link makeFakeChildFrame}) so
 * `resolveDeepLocatorCandidates`'s internal (no-pre-resolved-`FrameTarget`)
 * `resolveFrameTarget` pass reaches a working scan seam instead of degrading
 * to the legacy per-candidate loop; (b) a `textContentSpy` counting every
 * `nth(i).textContent()` call across the whole hop, the direct signature of
 * the legacy loop the batched scan is meant to make unreachable; and (c) an
 * optional `forceRejectIndex` whose `nth(index).click()` always throws
 * {@link NODE_NOT_ACTIONABLE_MESSAGE} regardless of that element's
 * registered `visible` flag — modeling a candidate the scan read as
 * laid-out a moment earlier but whose CDP box-model read rejects at click
 * time (the batched scan and the click are two separate CDP round-trips
 * over a racy OOPIF, so they can observe different states; this decouples
 * "survives the scan's visibility filter and gets ranked" from "the fake's
 * `visible` field", which the fake otherwise ties together).
 */
function makeFakeTopPage(
  topUrl: { current: string },
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame,
  options: { forceRejectIndex?: number } = {}
) {
  const session = { on: () => {}, off: () => {} };
  const { frame: childFrame, scanSpy } = makeFakeChildFrame(childUrls, deepLocatorFrame);
  const fakeDeepLocator = makeFakeDeepLocator(deepLocatorFrame);
  const textContentSpy = vi.fn();
  const forceRejectSpy = vi.fn();
  const wrappedDeepLocator = (selector: string) => {
    const delegate = fakeDeepLocator(selector);
    return {
      ...delegate,
      nth: (index: number) => {
        const inner = fakeDeepLocator(selector).nth(index);
        return {
          ...inner,
          textContent: async () => {
            textContentSpy();
            return inner.textContent();
          },
          click: async () => {
            if (options.forceRejectIndex === index) {
              forceRejectSpy();
              throw new Error(NODE_NOT_ACTIONABLE_MESSAGE);
            }
            await inner.click();
            childUrls.current = `${CHILD_ORIGIN}/application/abc-123/basic-info`;
          },
        };
      },
    };
  };
  const page = {
    evaluate: async (expr: unknown) => {
      const iframeSrcMatch = /document\.querySelector\((.+?)\)/.exec(String(expr));
      if (iframeSrcMatch) {
        const selector = JSON.parse(iframeSrcMatch[1] as string) as string;
        return selector === IFRAME_SELECTOR
          ? { matched: true, src: CHILD_SRC }
          : { matched: false, src: null };
      }
      return null;
    },
    url: () => topUrl.current,
    title: async () => "UCHealth Careers",
    locator: () => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async () => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
    frames: () => [childFrame],
    deepLocator: wrappedDeepLocator,
  } as unknown as import("@browserbasehq/stagehand").Page;
  return { page, scanSpy, textContentSpy, forceRejectSpy };
}

/** Builds the 371-element hop's filler run: distinct, non-matching text so every filler scores 0 against the step's tagged phrases and can never outrank a genuine text match. */
function buildFillerRun(count: number, offset: number): string[] {
  return Array.from({ length: count }, (_, i) => `filler-node-${offset + i}`);
}

async function runManualApplicationStep(
  deepLocatorFrame: FakeDeepLocatorFrame,
  elements: ReadonlyArray<string | { text: string; visible?: boolean }>,
  options: { forceRejectIndex?: number } = {}
) {
  registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, elements);
  const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
  const childUrls = { current: CHILD_SRC };
  const stagehand = makeFakeStagehandObserveOnceThenBlind();
  const { page, scanSpy, textContentSpy, forceRejectSpy } = makeFakeTopPage(
    topUrl,
    childUrls,
    deepLocatorFrame,
    options
  );

  const result = await runHealingFlow({
    stagehand,
    page,
    steps: [
      { instruction: MANUAL_APPLICATION_STEP, optional: false, upload: false, submitStep: false },
    ],
    logger: testLogger,
    anthropic: null,
    resumeFixture: null,
    frameSelector: IFRAME_SELECTOR,
  });

  const hop = deepLocatorFrame.get(HOP_SELECTOR);
  return { result, hop, childUrls, scanSpy, textContentSpy, forceRejectSpy };
}

describe("flow-runner dense-OOPIF-form regression pin (uchealth-7: 371 candidates, hidden decoy, actionability budget)", () => {
  beforeEach(() => {
    loggerStub.warn.mockClear();
  });

  it("resolves a 371-candidate hop in one frame evaluate, zero per-candidate textContent() calls, and clicks only the rendered control — never the hidden decoy sharing its text", async () => {
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    const hiddenDecoyIndex = 369;
    const renderedTargetIndex = 370;
    const elements = [
      "",
      ...buildFillerRun(hiddenDecoyIndex - 1, 0),
      { text: RENDERED_TARGET_TEXT, visible: false },
      { text: RENDERED_TARGET_TEXT, visible: true },
    ];
    expect(elements).toHaveLength(TOTAL_CANDIDATES);

    const { result, hop, childUrls, scanSpy, textContentSpy } = await runManualApplicationStep(
      deepLocatorFrame,
      elements
    );

    // (a) resolved and clicked within budget, no enumeration-abort.
    expect(result.lastStepIndex).toBe(0);
    expect(childUrls.current).toBe(`${CHILD_ORIGIN}/application/abc-123/basic-info`);
    expect(loggerStub.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("aborted after exceeding")
    );

    // (b) one frame-scoped batched scan, zero per-candidate round-trips.
    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(textContentSpy).not.toHaveBeenCalled();

    // (c) the rendered control was clicked; the hidden decoy — same text,
    // no layout box — never was.
    // biome-ignore lint/style/noNonNullAssertion: the hop was registered above
    const elementsRegistered = hop!.elements;
    expect(elementsRegistered[renderedTargetIndex]?.clicks).toBeGreaterThan(0);
    expect(elementsRegistered[hiddenDecoyIndex]?.clicks).toBe(0);
  });

  it("when the top-ranked candidate rejects with the CDP -32000 layout-object error, the step still succeeds via the next candidate", async () => {
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    const rejectingDecoyIndex = 1;
    const renderedTargetIndex = 370;
    const elements = [
      "",
      RENDERED_TARGET_TEXT,
      ...buildFillerRun(renderedTargetIndex - rejectingDecoyIndex - 1, 0),
      RENDERED_TARGET_TEXT,
    ];
    expect(elements).toHaveLength(TOTAL_CANDIDATES);

    const { result, hop, childUrls, scanSpy, forceRejectSpy } = await runManualApplicationStep(
      deepLocatorFrame,
      elements,
      { forceRejectIndex: rejectingDecoyIndex }
    );

    expect(result.lastStepIndex).toBe(0);
    expect(childUrls.current).toBe(`${CHILD_ORIGIN}/application/abc-123/basic-info`);
    // biome-ignore lint/style/noNonNullAssertion: the hop was registered above
    const elementsRegistered = hop!.elements;
    expect(elementsRegistered[renderedTargetIndex]?.clicks).toBeGreaterThan(0);
    expect(elementsRegistered[rejectingDecoyIndex]?.clicks).toBe(0);
    // The rejecting candidate — tied on text, ranked first by DOM order —
    // was actually offered to a click and rejected, not silently skipped.
    expect(forceRejectSpy).toHaveBeenCalledTimes(1);
    // Recovery must not cost more than one extra resolution: whether it's
    // an in-attempt candidate walk over one scan, or a second attempt's
    // re-resolve-and-exclude, either is a legitimate way to satisfy "still
    // succeeds via the next candidate" — this file pins the observable
    // outcome, not which internal mechanism (owned by the deepLocator
    // call-site wiring, not this suite) supplies it.
    expect(scanSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
