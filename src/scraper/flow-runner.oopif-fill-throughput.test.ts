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
  makeFakeFrameSelectByIndex,
  registerDeepLocatorHopElements,
  registerDeepLocatorHopLatency,
} from "@/scraper/deep-locator-fake";
import {
  buildFillFrameCandidateExpr,
  buildScanFrameCandidatesExpr,
  buildSelectFrameCandidateExpr,
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

/** Option the step instruction asks to be chosen on the Country dropdown. */
const SELECT_VALUE = "United States";
/** Verbatim step instruction shape the flow's select steps use with a quoted question label — `parseSelectStep` extracts `option: "United States"` and `questionLabel: "Country"`, routing through the same deterministic field-label branch `FIRST_NAME_STEP` does (the select counterpart of `fillStep`'s `fieldTarget`). */
const COUNTRY_STEP = "Select 'United States' in the 'Country' dropdown";
/** The select branch's rendered-target accessible text — the select counterpart of `RENDERED_TARGET_TEXT`; shares the same {@link HIDDEN_DECOY_INDEX}/{@link RENDERED_TARGET_INDEX} shape via {@link buildDenseCandidateElements}. */
const SELECT_TARGET_TEXT = "Country";

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

/** The select counterpart of {@link FILL_EXPR}: the exact evaluate expression `selectDeepLocatorCandidateOption`'s batched fast path issues once the field-label branch resolves `matched.index`. */
const SELECT_EXPR = buildSelectFrameCandidateExpr(
  INTERACTIVE_CANDIDATE_SELECTOR,
  RENDERED_TARGET_INDEX,
  SELECT_VALUE
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
 * Builds the shared 371-candidate shape every test in this file drives:
 * a hidden decoy sharing `targetText` at {@link HIDDEN_DECOY_INDEX} (filtered
 * out of the batched scan's own candidate set — Issue #2's visibility
 * filter), the genuine rendered target at {@link RENDERED_TARGET_INDEX}, and
 * non-matching filler everywhere else so no other candidate can outrank the
 * genuine text match.
 */
function buildDenseCandidateElements(
  targetText: string
): Array<string | { text: string; visible: boolean }> {
  const elements = [
    ...buildFillerRun(HIDDEN_DECOY_INDEX, 0),
    { text: targetText, visible: false },
    ...buildFillerRun(RENDERED_TARGET_INDEX - HIDDEN_DECOY_INDEX - 1, 100),
    targetText,
    ...buildFillerRun(TOTAL_CANDIDATES - RENDERED_TARGET_INDEX - 1, 200),
  ];
  expect(elements).toHaveLength(TOTAL_CANDIDATES);
  return elements;
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
 * unasserted side effect. `options.probeDelayMs` (default 0, matching every
 * other OOPIF throughput fixture) delays the iframe-src probe's resolution
 * the way `deep-locator-fake.ts`'s `makeFakeFrameResolutionPage` models
 * production CDP latency at frame-RESOLUTION time: a zero-budget internal
 * re-resolution (`resolveActuateFrameTarget`'s `{ timeoutMs: 0 }` pass) loses
 * that race once delayed, unlike the zero-delay default, which — because it
 * resolves same-tick — would let a wrongly-unthreaded `frameTarget` succeed
 * via a second, undetected probe.
 */
function makeFakeTopPage(
  topUrl: { current: string },
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame,
  options: { probeDelayMs?: number } = {}
) {
  const probeDelayMs = options.probeDelayMs ?? 0;
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
  const iframeProbeSpy = vi.fn();
  const page = {
    evaluate: async (expr: unknown) => {
      const iframeSrcMatch = /document\.querySelector\((.+?)\)/.exec(String(expr));
      if (iframeSrcMatch) {
        const selector = JSON.parse(iframeSrcMatch[1] as string) as string;
        if (selector === IFRAME_SELECTOR) iframeProbeSpy();
        const resolved =
          selector === IFRAME_SELECTOR
            ? { matched: true, src: CHILD_SRC }
            : { matched: false, src: null };
        if (probeDelayMs <= 0) return resolved;
        return new Promise((resolve) => setTimeout(() => resolve(resolved), probeDelayMs));
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
  return { page, scanSpy, fillByIndexSpy, legacyFillSpy, legacyInputValueSpy, iframeProbeSpy };
}

/** The select counterpart of {@link makeFakeChildFrame}: routes `SELECT_EXPR` to `makeFakeFrameSelectByIndex` instead of `FILL_EXPR` to `makeFakeFrameFillByIndex`. */
function makeFakeChildFrameForSelect(
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame
) {
  const scan = makeFakeFrameScan(deepLocatorFrame, HOP_SELECTOR);
  const scanSpy = vi.fn(scan);
  const selectByIndex = makeFakeFrameSelectByIndex(deepLocatorFrame, HOP_SELECTOR);
  const selectByIndexSpy = vi.fn(selectByIndex);
  return {
    frame: {
      evaluate: async (expr: unknown) => {
        if (expr === "location.href") return childUrls.current;
        if (expr === SCAN_EXPR) return scanSpy();
        if (expr === SELECT_EXPR) return selectByIndexSpy(RENDERED_TARGET_INDEX, SELECT_VALUE);
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
    selectByIndexSpy,
  };
}

/** The select counterpart of {@link makeFakeTopPage}: `nth()`'s returned delegate is wrapped so `legacySelectSpy`/`legacyInputValueSpy` fire only on an actual per-index `selectOption()`/`inputValue()` invocation, the two the legacy select fallback (and nothing else) drives. */
function makeFakeTopPageForSelect(
  topUrl: { current: string },
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame
) {
  const session = { on: () => {}, off: () => {} };
  const {
    frame: childFrame,
    scanSpy,
    selectByIndexSpy,
  } = makeFakeChildFrameForSelect(childUrls, deepLocatorFrame);
  const legacySelectSpy = vi.fn();
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
          selectOption: async (values: string | string[]) => {
            legacySelectSpy();
            return inner.selectOption(values);
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
  return { page, scanSpy, selectByIndexSpy, legacySelectSpy, legacyInputValueSpy, iframeProbeSpy };
}

describe("flow-runner cascade fill actuation throughput (batched fill-by-index over the legacy per-index fallback)", () => {
  beforeEach(() => {
    loggerStub.warn.mockClear();
  });

  it("fills a 371-candidate hop's target at index 40 via exactly one batched fill evaluate, inside STEP_WATCHDOG_MS, with zero per-index delegate resolves", async () => {
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    const elements = buildDenseCandidateElements(RENDERED_TARGET_TEXT);
    const hop = registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, elements);
    registerDeepLocatorHopLatency(hop, {
      delayOn: ["fill", "inputValue"],
      delayMs: MEASURED_DELEGATE_ROUND_TRIP_MS,
    });

    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const stagehand = makeFakeStagehandObserveOnceThenBlind();
    const { page, scanSpy, fillByIndexSpy, legacyFillSpy, legacyInputValueSpy, iframeProbeSpy } =
      makeFakeTopPage(topUrl, childUrls, deepLocatorFrame);

    const startedAt = Date.now();
    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [{ instruction: FIRST_NAME_STEP, optional: false, upload: false, submitStep: false }],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
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

    // The iframe-src probe backing `resolveFrameTarget` fires exactly once —
    // the per-step resolution `executeStepWithHealing` already did before
    // the cascade ever ran. `fillDeepLocatorCandidate`'s `actuateCandidateBatched`
    // (`deep-locator-actuate.ts`) re-resolves internally whenever its caller
    // omits `timeoutOptions.frameTarget`, which would silently succeed via a
    // SECOND probe here (the fake resolves instantly, masking the cost a
    // real CDP round-trip would pay) — so this is the assertion that
    // actually pins "the caller passed its own already-resolved
    // frameTarget", not just "the fill ended up batched somehow". Mirrors
    // `flow-runner.oopif-click-throughput.test.ts`'s identical assertion.
    expect(iframeProbeSpy).toHaveBeenCalledTimes(1);

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

  it("fills the same 371-candidate target even when the step-level frame resolution pays realistic CDP latency (perf-002's latency-realistic probe, mirroring `deep-locator-fake.ts`'s `makeFakeFrameResolutionPage`) — still exactly one iframe probe, one batched fill evaluate, zero legacy delegate calls", async () => {
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    const elements = buildDenseCandidateElements(RENDERED_TARGET_TEXT);
    const hop = registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, elements);
    registerDeepLocatorHopLatency(hop, {
      delayOn: ["fill", "inputValue"],
      delayMs: MEASURED_DELEGATE_ROUND_TRIP_MS,
    });

    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const stagehand = makeFakeStagehandObserveOnceThenBlind();
    const { page, scanSpy, fillByIndexSpy, legacyFillSpy, legacyInputValueSpy, iframeProbeSpy } =
      makeFakeTopPage(topUrl, childUrls, deepLocatorFrame, {
        // A zero-budget internal re-resolution (`resolveActuateFrameTarget`'s
        // `{ timeoutMs: 0 }` pass) loses this race once the probe no longer
        // resolves same-tick — unlike the sibling test above, where a
        // wrongly-unthreaded `frameTarget` would still silently succeed via a
        // second, undetected probe. This is the offline reproduction of the
        // production degrade the bug report measured (a real CDP round-trip
        // never resolves same-tick).
        probeDelayMs: 50,
      });

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [{ instruction: FIRST_NAME_STEP, optional: false, upload: false, submitStep: false }],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: IFRAME_SELECTOR,
    });

    expect(result.lastStepIndex).toBe(0);
    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(fillByIndexSpy).toHaveBeenCalledTimes(1);
    expect(fillByIndexSpy).toHaveBeenCalledWith(RENDERED_TARGET_INDEX, FILL_VALUE);
    expect(legacyFillSpy).not.toHaveBeenCalled();
    expect(legacyInputValueSpy).not.toHaveBeenCalled();
    expect(iframeProbeSpy).toHaveBeenCalledTimes(1);
    expect(hop.elements[RENDERED_TARGET_INDEX]?.filledWith).toBe(FILL_VALUE);
  });
});

describe("flow-runner cascade select actuation throughput (batched select-by-index over the legacy per-index fallback)", () => {
  beforeEach(() => {
    loggerStub.warn.mockClear();
  });

  it("selects the same 371-candidate hop's target at index 40 via exactly one batched select evaluate, with zero per-index delegate resolves — the select counterpart of the fill test above", async () => {
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    const elements = buildDenseCandidateElements(SELECT_TARGET_TEXT);
    const hop = registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, elements);
    registerDeepLocatorHopLatency(hop, {
      delayOn: ["selectOption", "inputValue"],
      delayMs: MEASURED_DELEGATE_ROUND_TRIP_MS,
    });

    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const stagehand = makeFakeStagehandObserveOnceThenBlind();
    const {
      page,
      scanSpy,
      selectByIndexSpy,
      legacySelectSpy,
      legacyInputValueSpy,
      iframeProbeSpy,
    } = makeFakeTopPageForSelect(topUrl, childUrls, deepLocatorFrame);

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: [{ instruction: COUNTRY_STEP, optional: false, upload: false, submitStep: false }],
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: IFRAME_SELECTOR,
    });

    expect(result.lastStepIndex).toBe(0);
    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(selectByIndexSpy).toHaveBeenCalledTimes(1);
    expect(selectByIndexSpy).toHaveBeenCalledWith(RENDERED_TARGET_INDEX, SELECT_VALUE);
    expect(legacySelectSpy).not.toHaveBeenCalled();
    expect(legacyInputValueSpy).not.toHaveBeenCalled();
    expect(iframeProbeSpy).toHaveBeenCalledTimes(1);
    expect(hop.elements[RENDERED_TARGET_INDEX]?.filledWith).toBe(SELECT_VALUE);
  });
});
