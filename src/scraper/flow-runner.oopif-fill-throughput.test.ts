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
  makeFakeFrameFillByIndex,
  makeFakeFrameScan,
  registerDeepLocatorHopElements,
  registerDeepLocatorHopLatency,
} from "@/scraper/deep-locator-fake";
import {
  buildFillFrameCandidateExpr,
  buildScanFrameCandidatesExpr,
  INTERACTIVE_CANDIDATE_SELECTOR,
} from "@/scraper/deep-locator-scan";
import { runHealingFlow, STEP_WATCHDOG_MS } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins the fill-side counterpart of `flow-runner.oopif-click-throughput.test.ts`'s
 * regression: the deterministic field-label fill branch (`flow-runner.ts`,
 * the "a fill/select step must actuate the NAMED FIELD" comment) must reach
 * `fillDeepLocatorCandidate`'s batched `actuateCandidateBatched` fast path
 * (`deep-locator-actuate.ts`), which issues one frame-scoped
 * `buildFillFrameCandidateExpr` evaluate, instead of degrading to the legacy
 * `deepLocator(hop).nth(index).fill()` + `.inputValue()` pair whose cost
 * scales `index + 1` serial CDP round-trips each (see
 * `DEEP_LOCATOR_CLICK_INDEX_ROUND_TRIP_MS`'s docs). Distinct from
 * `flow-runner.oopif-dense-form-acceptance.test.ts`, which already carries
 * the full click -> fill -> upload -> submit sequence over the same dense
 * fixture but asserts correctness, not throughput — this file stays
 * narrowly a throughput pin so a future change that quietly restores the
 * per-index fill walk fails an offline test instead of only surfacing on
 * the next live UCHealth run.
 */

const TOP_ORIGIN = "https://careers.uchealth.org";
const CHILD_ORIGIN = "https://apply.talemetry.com";
const IFRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123`;
/** Must match the field-label fill branch's actual hop — `flow-runner.ts` scopes it to `INTERACTIVE_CANDIDATE_SELECTOR`, not `"*"`. */
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
/** The exact evaluate expression `resolveDeepLocatorCandidates` issues for the cascade's interactive-scoped enumeration hop. */
const SCAN_EXPR = buildScanFrameCandidatesExpr(INTERACTIVE_CANDIDATE_SELECTOR);

/** Value the step instruction asks to be typed into the First Name field. */
const FILL_VALUE = "Jane";
/** Verbatim step instruction shape the flow's fill steps use — `parseFillStep` extracts `fieldLabel: "'First Name'"` and `value: "Jane"` from this. */
const FIRST_NAME_STEP = "Fill in the 'First Name' field with 'Jane'";

/** Matches the uchealth-7 bug report's measured candidate count for `#talemetry_apply_iframe >> *`. */
const TOTAL_CANDIDATES = 371;

/** Measured cost of one delegate round-trip through Browserbase's proxied CDP into the cross-origin OOPIF (uchealth-7's `13/371 candidates enumerated in 60s` measurement). */
const MEASURED_DELEGATE_ROUND_TRIP_MS = 4_600;

const RENDERED_TARGET_TEXT = "First Name";
const HIDDEN_DECOY_INDEX = 35;
/** Comfortably above the 30-candidate floor: at the measured per-round-trip cost, the legacy `fill()` + `inputValue()` fallback would cost `2 * 41 * 4.6s ≈ 377.2s` — well past `STEP_WATCHDOG_MS` — so this index only survives if the fix's batched path is actually taken. */
const RENDERED_TARGET_INDEX = 40;

/** The exact evaluate expression `fillDeepLocatorCandidate`'s batched fast path issues once the field-label branch resolves `matched.index` — both the index and value are known ahead of time here, so this is matched by equality rather than a pattern. */
const FILL_EXPR = buildFillFrameCandidateExpr(
  INTERACTIVE_CANDIDATE_SELECTOR,
  RENDERED_TARGET_INDEX,
  FILL_VALUE
);

const testLogger = {
  info: vi.fn(),
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/**
 * Fake Stagehand whose `observe()` returns a single dummy candidate on its
 * FIRST call only, then `[]` on every call after — `act()` always reports no
 * actionable candidate, forcing attempt 1 to fail and the cascade into
 * attempt 2's observe-act branch, the one that owns the deterministic
 * field-label fill walk under test. Mirrors `flow-runner.oopif-click-
 * throughput.test.ts`'s fixture exactly (see its docblock for why the first
 * observe call must succeed).
 */
function makeFakeStagehandObserveOnceThenBlind() {
  let observeCalls = 0;
  return {
    act: async () => ({
      success: false,
      message: "no actionable candidate",
      actionDescription: FIRST_NAME_STEP,
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

/** Builds the 371-element hop's filler run: distinct, non-matching text so every filler scores 0 against the step's tagged field label and can never outrank the genuine text match. */
function buildFillerRun(count: number, offset: number): string[] {
  return Array.from({ length: count }, (_, i) => `filler-node-${offset + i}`);
}

/**
 * Minimal fake `Frame`: `location.href` backs onto its own mutable ref, the
 * batched-scan expression (`SCAN_EXPR`) routes to `makeFakeFrameScan`
 * (spied so the test can assert it ran exactly once), and the batched-fill
 * expression for the resolved target (`FILL_EXPR`, matched by equality since
 * both its index and value are known ahead of time) routes to
 * `makeFakeFrameFillByIndex` (spied so the test can assert it ran exactly
 * once, at the target's index, with the step's value). Any other expression
 * returns `null`, matching every other OOPIF fixture in this suite.
 */
function makeFakeChildFrame(
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame
) {
  const scan = makeFakeFrameScan(deepLocatorFrame, HOP_SELECTOR);
  const scanSpy = vi.fn(scan);
  const fillByIndex = makeFakeFrameFillByIndex(deepLocatorFrame, HOP_SELECTOR);
  const fillByIndexSpy = vi.fn(fillByIndex);
  return {
    frame: {
      evaluate: async (expr: unknown) => {
        if (expr === "location.href") return childUrls.current;
        if (expr === SCAN_EXPR) return scanSpy();
        if (expr === FILL_EXPR) return fillByIndexSpy(RENDERED_TARGET_INDEX, FILL_VALUE);
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
    fillByIndexSpy,
  };
}

/**
 * Fake two-frame `Page`. `page.deepLocator(hopSelector)` itself is called
 * unconditionally once per enumeration pass (`resolveDeepLocatorCandidates`
 * probes delegate availability before it ever decides whether to use the
 * batched scan), so a bare call-count spy on `deepLocator` can't distinguish
 * "enumeration ran" from "the legacy per-index fill fallback ran" — instead,
 * `nth()`'s returned delegate is wrapped so `legacyFillSpy`/`legacyInputValueSpy`
 * fire only on an actual per-index `fill()`/`inputValue()` invocation, the
 * two the legacy fallback (and nothing else) drives. Every registered
 * element's `fill()`/`inputValue()` additionally charges
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
    fillByIndexSpy,
  } = makeFakeChildFrame(childUrls, deepLocatorFrame);
  const legacyFillSpy = vi.fn();
  const legacyInputValueSpy = vi.fn();
  const fakeDeepLocator = makeFakeDeepLocator(deepLocatorFrame);
  const wrapDelegate = (selector: string) => {
    const delegate = fakeDeepLocator(selector);
    return {
      ...delegate,
      nth: (index: number) => {
        const inner = fakeDeepLocator(selector).nth(index);
        return {
          ...inner,
          fill: async (value: string) => {
            legacyFillSpy();
            return inner.fill(value);
          },
          inputValue: async () => {
            legacyInputValueSpy();
            return inner.inputValue();
          },
        };
      },
    };
  };
  const deepLocatorSpy = vi.fn(wrapDelegate);
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
    deepLocator: deepLocatorSpy,
  } as unknown as import("@browserbasehq/stagehand").Page;
  return { page, scanSpy, fillByIndexSpy, legacyFillSpy, legacyInputValueSpy };
}

describe("flow-runner cascade fill actuation throughput (batched fill-by-index over the legacy per-index fallback)", () => {
  beforeEach(() => {
    loggerStub.warn.mockClear();
  });

  it("fills a 371-candidate hop's target at index 40 via exactly one batched fill evaluate, inside STEP_WATCHDOG_MS, with zero per-index delegate resolves", async () => {
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
      delayOn: ["fill", "inputValue"],
      delayMs: MEASURED_DELEGATE_ROUND_TRIP_MS,
    });

    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const stagehand = makeFakeStagehandObserveOnceThenBlind();
    const { page, scanSpy, fillByIndexSpy, legacyFillSpy, legacyInputValueSpy } = makeFakeTopPage(
      topUrl,
      childUrls,
      deepLocatorFrame
    );

    const startedAt = Date.now();
    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [{ instruction: FIRST_NAME_STEP, optional: false, upload: false, submitStep: false }],
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
    expect(loggerStub.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("aborted after exceeding")
    );

    // The deterministic field-label fill branch reports its own DOM
    // write/read-back as the verification signal directly (`flow-runner.ts`
    // sets `record.verifiedBy = "dom"` right before this log line) rather
    // than routing through a generic resolved-action verifier.
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining(`deepLocator filled "${RENDERED_TARGET_TEXT}" with "${FILL_VALUE}"`)
    );

    // One batched scan (enumeration) and one batched fill (actuation) — the
    // whole walk resolved in two frame-scoped evaluate calls, never the
    // legacy per-index delegate's fill()/inputValue().
    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(fillByIndexSpy).toHaveBeenCalledTimes(1);
    expect(fillByIndexSpy).toHaveBeenCalledWith(RENDERED_TARGET_INDEX, FILL_VALUE);
    expect(legacyFillSpy).not.toHaveBeenCalled();
    expect(legacyInputValueSpy).not.toHaveBeenCalled();

    // The rendered target was filled; the hidden decoy sharing its
    // accessible name — filtered out of the batched scan's own candidate
    // set — never was, and no other index was written.
    const elementsRegistered = hop.elements;
    expect(elementsRegistered[RENDERED_TARGET_INDEX]?.filledWith).toBe(FILL_VALUE);
    for (const [index, element] of elementsRegistered.entries()) {
      if (index === RENDERED_TARGET_INDEX) continue;
      expect(element.filledWith).toBeNull();
    }
  });
});
