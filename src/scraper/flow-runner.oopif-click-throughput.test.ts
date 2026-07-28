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
  makeFakeFrameClickByIndex,
  makeFakeFrameScan,
  registerDeepLocatorHopElements,
  registerDeepLocatorHopLatency,
} from "@/scraper/deep-locator-fake";
import {
  buildScanFrameCandidatesExpr,
  INTERACTIVE_CANDIDATE_SELECTOR,
} from "@/scraper/deep-locator-scan";
import { runHealingFlow, STEP_WATCHDOG_MS } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins perf-004's fix: the observe-act cascade's candidate-click closure
 * (`flow-runner.ts`) must pass its already-resolved `frameTarget` into
 * `clickDeepLocatorCandidate` so the click actually takes
 * `clickCandidateBatched`'s one-round-trip fast path
 * (`deep-locator-candidates.ts`) instead of silently falling back to the
 * legacy `DeepLocatorDelegate.click()`, whose cost scales `index + 1` serial
 * CDP round-trips (see `DEEP_LOCATOR_CLICK_INDEX_ROUND_TRIP_MS`'s docs).
 * Distinct from `flow-runner.oopif-dense-form-budget.test.ts`, which pins
 * ENUMERATION cost (the batched scan) and — because it predates this fix —
 * still exercises the legacy click fallback; this file pins ACTUATION cost
 * specifically, at a candidate index high enough that the legacy per-index
 * cost would matter if the fix ever regressed.
 */

const TOP_ORIGIN = "https://careers.uchealth.org";
const CHILD_ORIGIN = "https://apply.talemetry.com";
const IFRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123`;
/** Must match the cascade's actual hop — `flow-runner.ts` scopes the observe-act fallback to `INTERACTIVE_CANDIDATE_SELECTOR`, not `"*"`. */
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
/** The exact evaluate expression `resolveDeepLocatorCandidates` issues for the cascade's interactive-scoped hop. */
const SCAN_EXPR = buildScanFrameCandidatesExpr(INTERACTIVE_CANDIDATE_SELECTOR);
/** `buildClickFrameCandidateExpr` interpolates `matches[<index>]` verbatim — matched here to route a click evaluate to the fake without inspecting the whole generated expression string. */
const CLICK_INDEX_PATTERN = /matches\[(\d+)\]/;

/** Verbatim step instruction from the bug report's flow. */
const MANUAL_APPLICATION_STEP =
  "In the application widget, click the 'Manual Application' button to skip the resume-upload flow entirely. Do NOT click 'Upload a Resume/CV', 'Use LinkedIn Profile', 'Upload From Dropbox', or 'Upload From OneDrive'.";

/** Matches the uchealth-7 bug report's measured candidate count for `#talemetry_apply_iframe >> *`. */
const TOTAL_CANDIDATES = 371;

/** Measured cost of one delegate round-trip through Browserbase's proxied CDP into the cross-origin OOPIF (uchealth-7's `13/371 candidates enumerated in 60s` measurement). */
const MEASURED_DELEGATE_ROUND_TRIP_MS = 4_600;

const RENDERED_TARGET_TEXT = "Manual Application";
const HIDDEN_DECOY_INDEX = 35;
/** Comfortably above the 30-candidate floor: at the measured per-round-trip cost, the legacy `index + 1` fallback would cost 41 * 4.6s ≈ 188.6s — well past `STEP_WATCHDOG_MS` — so this index only survives if the fix's batched path is actually taken. */
const RENDERED_TARGET_INDEX = 40;

const testLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/**
 * Fake Stagehand whose `observe()` returns a single dummy candidate on its
 * FIRST call only, then `[]` on every call after — `act()` always reports no
 * actionable candidate, forcing attempt 1 to fail and the cascade into
 * attempt 2's observe-act branch, the one that owns the click walk under
 * test. Mirrors `flow-runner.oopif-dense-form-budget.test.ts`'s fixture
 * exactly (see its docblock for why the first observe call must succeed).
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

/** Builds the 371-element hop's filler run: distinct, non-matching text so every filler scores 0 against the step's tagged phrases and can never outrank the genuine text match. */
function buildFillerRun(count: number, offset: number): string[] {
  return Array.from({ length: count }, (_, i) => `filler-node-${offset + i}`);
}

/**
 * Minimal fake `Frame`: `location.href` backs onto its own mutable ref, the
 * batched-scan expression (`SCAN_EXPR`) routes to `makeFakeFrameScan`
 * (spied so the test can assert it ran exactly once), and any batched-click
 * expression (matched via `CLICK_INDEX_PATTERN` — the click expression
 * embeds a fresh `index` per call, so it can't be compared with `===` the
 * way `SCAN_EXPR` is) routes to `makeFakeFrameClickByIndex` (spied so the
 * test can assert it ran exactly once, at the target's index). Any other
 * expression returns `null`, matching every other OOPIF fixture in this
 * suite.
 */
function makeFakeChildFrame(
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame
) {
  const scan = makeFakeFrameScan(deepLocatorFrame, HOP_SELECTOR);
  const scanSpy = vi.fn(scan);
  const clickByIndex = makeFakeFrameClickByIndex(deepLocatorFrame, HOP_SELECTOR);
  const clickByIndexSpy = vi.fn(clickByIndex);
  return {
    frame: {
      evaluate: async (expr: unknown) => {
        if (expr === "location.href") return childUrls.current;
        if (expr === SCAN_EXPR) return scanSpy();
        const clickMatch = typeof expr === "string" ? CLICK_INDEX_PATTERN.exec(expr) : null;
        if (clickMatch?.[1]) {
          const result = await clickByIndexSpy(Number(clickMatch[1]));
          if (result.clicked) childUrls.current = `${CHILD_ORIGIN}/application/abc-123/basic-info`;
          return result;
        }
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
    clickByIndexSpy,
  };
}

/**
 * Fake two-frame `Page`. `page.deepLocator(hopSelector)` itself is called
 * unconditionally once per enumeration pass (`resolveDeepLocatorCandidates`
 * probes delegate availability before it ever decides whether to use the
 * batched scan), so a bare call-count spy on `deepLocator` can't distinguish
 * "enumeration ran" from "the legacy per-index click fallback ran" — instead,
 * `nth()`'s returned delegate is wrapped so `legacyClickSpy`/`textContentSpy`
 * fire only on an actual per-index `click()`/`textContent()` invocation, the
 * two the legacy fallback (and nothing else) drives. Every registered
 * element's `click()`/`textContent()` additionally charges
 * `MEASURED_DELEGATE_ROUND_TRIP_MS` per round-trip (scaled by index,
 * mirroring Stagehand's real `resolveAtIndex` cost) via
 * `registerDeepLocatorHopLatency` — a regression to the legacy fallback
 * would make this fixture's own delegate cost model the failure, not just an
 * unasserted side effect.
 */
function makeFakeTopPage(
  topUrl: { current: string },
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame
) {
  const session = { on: () => {}, off: () => {} };
  const {
    frame: childFrame,
    scanSpy,
    clickByIndexSpy,
  } = makeFakeChildFrame(childUrls, deepLocatorFrame);
  const legacyClickSpy = vi.fn();
  const textContentSpy = vi.fn();
  const fakeDeepLocator = makeFakeDeepLocator(deepLocatorFrame);
  const wrapDelegate = (selector: string) => {
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
            legacyClickSpy();
            return inner.click();
          },
        };
      },
    };
  };
  const deepLocatorSpy = vi.fn(wrapDelegate);
  const iframeProbeSpy = vi.fn();
  const page = {
    evaluate: async (expr: unknown) => {
      const iframeSrcMatch = /document\.querySelector\((.+?)\)/.exec(String(expr));
      if (iframeSrcMatch) {
        const selector = JSON.parse(iframeSrcMatch[1] as string) as string;
        if (selector === IFRAME_SELECTOR) iframeProbeSpy();
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
    deepLocator: deepLocatorSpy,
  } as unknown as import("@browserbasehq/stagehand").Page;
  return { page, scanSpy, clickByIndexSpy, legacyClickSpy, textContentSpy, iframeProbeSpy };
}

describe("flow-runner cascade click actuation throughput (perf-004: batched click-by-index over the legacy per-index fallback)", () => {
  beforeEach(() => {
    loggerStub.warn.mockClear();
  });

  it("clicks a 371-candidate hop's target at index 40 via exactly one batched click evaluate, inside STEP_WATCHDOG_MS, with zero per-index delegate resolves", async () => {
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    const elements = [
      ...buildFillerRun(HIDDEN_DECOY_INDEX, 0),
      { text: RENDERED_TARGET_TEXT, visible: false },
      ...buildFillerRun(RENDERED_TARGET_INDEX - HIDDEN_DECOY_INDEX - 1, 100),
      RENDERED_TARGET_TEXT,
      ...buildFillerRun(TOTAL_CANDIDATES - RENDERED_TARGET_INDEX - 1, 200),
    ];
    expect(elements).toHaveLength(TOTAL_CANDIDATES);
    const hop = registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, elements);
    registerDeepLocatorHopLatency(hop, {
      delayOn: ["click", "textContent"],
      delayMs: MEASURED_DELEGATE_ROUND_TRIP_MS,
    });

    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const stagehand = makeFakeStagehandObserveOnceThenBlind();
    const { page, scanSpy, clickByIndexSpy, legacyClickSpy, textContentSpy, iframeProbeSpy } =
      makeFakeTopPage(topUrl, childUrls, deepLocatorFrame);

    const startedAt = Date.now();
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
    const elapsedMs = Date.now() - startedAt;

    // Succeeded, and inside budget — with zero delegate round-trips charged,
    // the registered per-round-trip delay is never incurred.
    expect(result.lastStepIndex).toBe(0);
    expect(elapsedMs).toBeLessThan(STEP_WATCHDOG_MS);
    expect(childUrls.current).toBe(`${CHILD_ORIGIN}/application/abc-123/basic-info`);
    expect(loggerStub.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("aborted after exceeding")
    );

    // One batched scan (enumeration) and one batched click (actuation) —
    // the whole walk resolved in two frame-scoped evaluate calls, never the
    // legacy per-index delegate's textContent()/click().
    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(clickByIndexSpy).toHaveBeenCalledTimes(1);
    expect(clickByIndexSpy).toHaveBeenCalledWith(RENDERED_TARGET_INDEX);
    expect(textContentSpy).not.toHaveBeenCalled();
    expect(legacyClickSpy).not.toHaveBeenCalled();

    // The iframe-src probe backing `resolveFrameTarget` fires exactly once —
    // the per-step resolution `executeStepWithHealing` already did before
    // the cascade ever ran. `clickCandidateBatched` (`deep-locator-
    // candidates.ts`) re-resolves internally whenever its caller omits
    // `timeoutOptions.frameTarget`, which would silently succeed via a
    // SECOND probe here (the fake resolves instantly, masking the cost a
    // real CDP round-trip would pay) — so this is the assertion that
    // actually pins "the caller passed its own already-resolved
    // frameTarget", not just "the click ended up batched somehow".
    expect(iframeProbeSpy).toHaveBeenCalledTimes(1);

    // The rendered target was clicked; the hidden decoy sharing its text —
    // filtered out of the batched scan's own candidate set — never was.
    const elementsRegistered = hop.elements;
    expect(elementsRegistered[RENDERED_TARGET_INDEX]?.clicks).toBe(1);
    expect(elementsRegistered[HIDDEN_DECOY_INDEX]?.clicks).toBe(0);
  });
});
