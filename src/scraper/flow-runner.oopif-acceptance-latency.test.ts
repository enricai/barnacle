import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  type FakeDeepLocatorElementSpec,
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  makeFakeFrameClickByIndex,
  makeFakeFrameFillByIndex,
  makeFakeFrameScan,
  registerDeepLocatorHopElements,
  registerDeepLocatorHopLatency,
} from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import { type HealingFlowStep, runHealingFlow, STEP_WATCHDOG_MS } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Latency-charged counterpart to `flow-runner.oopif-dense-form-acceptance.
 * test.ts`'s offline acceptance run: the same 371-node dense-OOPIF-shaped
 * hop, driven through the REAL `runHealingFlow` stack, but with every
 * round-trip a real cross-origin CDP call would pay — the batched scan, the
 * batched click/fill actuations, AND the legacy per-index fallbacks they
 * replace — charged the uchealth-7 bug report's own measured cost
 * (`MEASURED_DELEGATE_ROUND_TRIP_MS`, matching `flow-runner.oopif-click-
 * throughput.test.ts`'s constant) under fake timers. The zero-cost original
 * acceptance file proves ranking/visibility/routing; this file proves the
 * bug report's own acceptance line — "found + clicked within the per-step
 * budget ... proceeds through the in-frame fills to a verified submit" — by
 * pinning that every step's actuation still lands inside `STEP_WATCHDOG_MS`
 * once real latency is on the clock. Kept as a sibling file (not merged into
 * the zero-cost acceptance file) so fake timers stay scoped to this suite
 * without forcing every existing real-timer assertion there onto a fake
 * clock, and so a budget regression here names itself distinctly from a
 * ranking/routing regression there.
 *
 * Registering the SAME `delayMs` on both a step's batched fast path
 * (`scan`/`clickByIndex`/`fillByIndex`) and its legacy fallback
 * (`click`/`textContent`/`fill`/`selectOption`/`inputValue`) makes this a
 * real regression pin, not a vacuous one: the batched path pays one
 * round-trip per step and stays comfortably inside budget, while a
 * regression that dropped back to the legacy per-index loop at the First/
 * Last Name fields' depth (~100/~200 of 371) would pay `index + 1` round
 * trips and blow both the per-call scaled watchdog and the assertion below —
 * exactly the shape `test-004`'s `batched-frame-actuation-seam` dependency
 * exists to prevent.
 */

const TOP_ORIGIN = "https://careers.uchealth.org";
const CHILD_ORIGIN = "https://apply.talemetry.com";
const IFRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123`;
/** The cascade's actual hop (`flow-runner.ts` scopes the observe-act fallback to `INTERACTIVE_CANDIDATE_SELECTOR`, not `"*"`) — must match so the fake's registered elements resolve at the same selector the cascade actuates through. */
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
const THANK_YOU_URL = `${CHILD_ORIGIN}/application/abc-123/thank-you`;
const SUBMITTED_STATE_SELECTOR = "[data-testid=thank-you]";

/** Measured cost of one delegate round-trip through Browserbase's proxied CDP into the cross-origin OOPIF (uchealth-7's `13/371 candidates enumerated in 60s` measurement) — same constant `flow-runner.oopif-click-throughput.test.ts` uses. */
const MEASURED_DELEGATE_ROUND_TRIP_MS = 4_600;

/** Fake-timer advance granularity and ceiling: many small ticks (not a few large jumps) so `advanceTimersByTimeAsync` — which only drains a bounded number of microtask turns per call — gives the real `runHealingFlow`/`resolveFrameTarget`/`resolveDeepLocatorCandidates` await chain enough chances to fully settle between each timer step, the same reason `flow-runner.oopif-hang-watchdog.test.ts` ticks in 1s increments rather than one large jump. */
const ADVANCE_STEP_MS = 1_000;
/** Matches `flow-runner.oopif-hang-watchdog.test.ts`'s `advancePastDeepLocatorHangs` budget — comfortably above the ~5 attempts-worth of round trips this fixture's steps (with retries) can accumulate. */
const MAX_ADVANCE_ITERATIONS = 300;

/** Verbatim step instruction from the bug report's flow. */
const MANUAL_APPLICATION_STEP =
  "In the application widget, click the 'Manual Application' button to skip the resume-upload flow entirely. Do NOT click 'Upload a Resume/CV', 'Use LinkedIn Profile', 'Upload From Dropbox', or 'Upload From OneDrive'.";
/** See `flow-runner.oopif-dense-form-acceptance.test.ts`'s docblock for why the field label is quoted alongside the value. */
const FIRST_NAME_STEP = "Fill in the 'First Name' field with 'Jane'";
const LAST_NAME_STEP = "Fill in the 'Last Name' field with 'Doe'";
const UPLOAD_STEP = "Upload resume";
const SUBMIT_STEP = "Click the final 'Submit' button";

const FIRST_NAME_ELEMENT: FakeDeepLocatorElementSpec = { text: "First Name" };
const LAST_NAME_ELEMENT: FakeDeepLocatorElementSpec = { text: "Last Name" };
const SUBMIT_ELEMENT: FakeDeepLocatorElementSpec = { text: "Submit" };

/** Unscoped/top-frame observe result — never the right candidate for any frame-scoped step. */
const TOP_FRAME_CANDIDATES = [
  { selector: "css=nav a.careers-home", description: "Careers home link", method: "click" },
  { selector: "css=button.share-linkedin", description: "Share on LinkedIn", method: "click" },
  { selector: "css=button#apply-now", description: "Apply now button", method: "click" },
];

/** The four verbatim negated decoys from the bug report's flow instruction — two rendered, two layout-less, same as the zero-cost acceptance fixture. */
const DECOYS: FakeDeepLocatorElementSpec[] = [
  { text: "Upload a Resume/CV", visible: true },
  { text: "Use LinkedIn Profile", visible: false },
  { text: "Upload From Dropbox", visible: true },
  { text: "Upload From OneDrive", visible: false },
];

/** Filler-block sizes summing to 363 — with the 4 decoys, the 3 fill/submit targets, and the real target, 371 total, matching the live-measured `"*"` match count. */
const FILLER_BLOCK_SIZES = [99, 99, 99, 66];

/** The First/Last Name fill targets and the Submit control, interspersed one per filler block (~index 100/201/302 of 371) — deliberately deep in the hop, not moved to low indexes, since the depth is what makes the batched-actuation budget pin meaningful. */
const FORM_FIELD_ELEMENTS: ReadonlyArray<FakeDeepLocatorElementSpec | undefined> = [
  FIRST_NAME_ELEMENT,
  LAST_NAME_ELEMENT,
  SUBMIT_ELEMENT,
  undefined,
];

/** Builds the 371-element DOM-order array a `"*"` hop over the dense Talemetry wizard resolves to, with "Manual Application" LAST in DOM order — see `flow-runner.oopif-dense-form-acceptance.test.ts`'s docblock for why DOM-order-last is deliberate. */
function buildDenseHopOrder(): Array<string | FakeDeepLocatorElementSpec> {
  const order: Array<string | FakeDeepLocatorElementSpec> = [];
  for (const [index, size] of FILLER_BLOCK_SIZES.entries()) {
    order.push(...Array.from({ length: size }, () => ""));
    const decoy = DECOYS[index];
    if (decoy) order.push(decoy);
    const formField = FORM_FIELD_ELEMENTS[index];
    if (formField) order.push(formField);
  }
  order.push("Manual Application");
  return order;
}

/** Position of the first element whose accessible name is `text`. */
function findElementIndex(
  order: ReadonlyArray<string | FakeDeepLocatorElementSpec>,
  text: string
): number {
  return order.findIndex((entry) => typeof entry !== "string" && entry.text === text);
}

/** In-memory model of the fields the acceptance sequence uploads/submits inside the OOPIF — no `filledWith` map needed here (unlike the zero-cost acceptance fixture): the fill/select actuators' own write-then-read-back IS the verification signal for the deepLocator field-target branch (`flow-runner.ts`'s `verifyDomEffect` never resolves a `deeplocator=` selector), so the fake hop's own per-element `filledWith` (asserted below) is sufficient. */
interface AcceptanceLatencyState {
  fileInputCount: number;
  uploadedFileName: string | null;
  submitted: boolean;
}

/** Matches a batched click/fill expression's `matches[<index>]` candidate lookup — shared across `buildClickFrameCandidateExpr`/`buildFillFrameCandidateExpr`, which both embed it verbatim (`deep-locator-scan.ts`). */
const CANDIDATE_INDEX_PATTERN = /matches\[(\d+)\]/;
/** Matches `buildFillFrameCandidateExpr`'s baked-in `const value = "...";` assignment — the fake never executes the expression, so the fill value has to be read back out of its source text instead. */
const FILL_VALUE_PATTERN = /const value = "([^"]*)";/;

/**
 * Fake child `Frame`: routes `buildScanFrameCandidatesExpr`'s (marker:
 * `accessibleName(el)`, unique to the scan expression),
 * `buildClickFrameCandidateExpr`'s (marker: `mousedown`, unique to the click
 * expression's dispatched events), and `buildFillFrameCandidateExpr`'s
 * (marker: `HTMLInputElement.prototype`, unique to the fill expression's
 * native-setter lookup) evaluate calls to the shared deepLocator-fake's
 * batched seams — the one-round-trip paths `deep-locator-candidates.ts`'s
 * `clickCandidateBatched` and `deep-locator-actuate.ts`'s
 * `actuateCandidateBatched` take when a frame seam is available, replacing
 * the zero-cost acceptance fixture's page-level legacy `nth(index).fill()`/
 * `.click()` override. No `buildSelectFrameCandidateOptionExpr` routing:
 * this fixture has no `<select>` step, so wiring one would be dead code.
 */
function makeDenseChildFrame(
  childUrls: { current: string },
  state: AcceptanceLatencyState,
  deepLocatorFrame: FakeDeepLocatorFrame,
  targetIndex: number,
  submitIndex: number
) {
  const scan = makeFakeFrameScan(deepLocatorFrame, HOP_SELECTOR);
  const scanSpy = vi.fn(scan);
  const clickByIndex = makeFakeFrameClickByIndex(deepLocatorFrame, HOP_SELECTOR);
  const clickByIndexSpy = vi.fn(async (index: number) => {
    const result = await clickByIndex(index);
    if (result.clicked && index === targetIndex) {
      childUrls.current = `${CHILD_ORIGIN}/application/abc-123/basic-info`;
    }
    if (result.clicked && index === submitIndex) {
      childUrls.current = THANK_YOU_URL;
      state.submitted = true;
    }
    return result;
  });
  const fillByIndex = makeFakeFrameFillByIndex(deepLocatorFrame, HOP_SELECTOR);
  const fillByIndexSpy = vi.fn(fillByIndex);

  return {
    frame: {
      evaluate: async (expr: unknown) => {
        const src = String(expr);
        if (src === "location.href") {
          return childUrls.current;
        }
        if (src === "document.readyState") return "complete";
        if (src.includes("accessibleName(el)")) {
          return scanSpy();
        }
        if (src.includes("mousedown")) {
          const indexMatch = CANDIDATE_INDEX_PATTERN.exec(src);
          return indexMatch ? clickByIndexSpy(Number(indexMatch[1])) : null;
        }
        if (src.includes("HTMLInputElement.prototype")) {
          const indexMatch = CANDIDATE_INDEX_PATTERN.exec(src);
          const value = FILL_VALUE_PATTERN.exec(src)?.[1];
          return indexMatch && value !== undefined
            ? fillByIndexSpy(Number(indexMatch[1]), value)
            : null;
        }
        if (src.includes("outerHTML") && src.includes("innerText")) {
          return { html: 500, text: "1:apply" };
        }
        if (src.includes('querySelectorAll("[class],[aria-invalid]")')) return 0;
        if (src.includes("querySelectorAll('input[type=file]').length")) {
          return state.fileInputCount;
        }
        if (src.includes("el.files && el.files.length > 0) { el.dispatchEvent")) {
          return state.uploadedFileName !== null;
        }
        if (src.includes("el.files && el.files.length > 0) return el.files.length")) {
          return state.uploadedFileName !== null ? 1 : 0;
        }
        if (src.includes("document.querySelector(sel)")) {
          return state.submitted ? SUBMITTED_STATE_SELECTOR : null;
        }
        return null;
      },
      locator: () => ({
        first: () => ({
          isChecked: async () => false,
          inputValue: async () => "",
          setInputFiles: async (file: { name: string }) => {
            state.uploadedFileName = file.name;
          },
        }),
      }),
    },
    scanSpy,
    clickByIndexSpy,
    fillByIndexSpy,
  };
}

/**
 * Fake two-frame `Page`. `deepLocator` is wired to the shared fake's
 * unwrapped legacy delegate — `resolveDeepLocatorCandidates` constructs it
 * unconditionally (`typeof page.deepLocator === "function" ? page.
 * deepLocator(hopSelector) : null`) even when the batched scan succeeds, so
 * it must exist and stay callable, but with every step routed through
 * `makeDenseChildFrame`'s batched seams it is never actually invoked for a
 * click/fill/enumeration round-trip on the happy path this test drives.
 */
function makeDenseTopPage(
  topUrl: { current: string },
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame,
  state: AcceptanceLatencyState,
  targetIndex: number,
  submitIndex: number
) {
  const session = { on: () => {}, off: () => {} };
  const {
    frame: childFrame,
    scanSpy,
    clickByIndexSpy,
    fillByIndexSpy,
  } = makeDenseChildFrame(childUrls, state, deepLocatorFrame, targetIndex, submitIndex);
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
    // Under fake timers, `waitForUploadNetworkSignal`'s `performance.now()`
    // deadline only advances when a real timer is scheduled — a no-op stub
    // would spin forever since virtual time never moves without one.
    waitForTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
    frames: () => [childFrame],
    deepLocator: makeFakeDeepLocator(deepLocatorFrame),
  } as unknown as import("@browserbasehq/stagehand").Page;
  return { page, scanSpy, clickByIndexSpy, fillByIndexSpy };
}

/**
 * Fake `Stagehand`: `observe()` is blind (`[]`) for every frame-scoped
 * instruction across every step, `act()` always phantom-fails — the same
 * "cannot see into the OOPIF at all" field condition
 * `flow-runner.oopif-dense-form-acceptance.test.ts`'s fixture models,
 * forcing every step through the deepLocator cascade under test.
 */
function makeDenseStagehand() {
  const hopPrefix = `${IFRAME_SELECTOR} >> `;
  return {
    act: async (input: unknown) => ({
      success: false,
      message: "no actionable candidate",
      actionDescription: typeof input === "string" ? input : MANUAL_APPLICATION_STEP,
      actions: [],
    }),
    observe: async (_instruction?: unknown, options?: { selector?: string }) => {
      const isFrameScoped = options?.selector?.startsWith(hopPrefix) ?? false;
      return isFrameScoped ? [] : TOP_FRAME_CANDIDATES;
    },
  } as unknown as import("@browserbasehq/stagehand").Stagehand;
}

const ACCEPTANCE_STEPS: HealingFlowStep[] = [
  { instruction: MANUAL_APPLICATION_STEP, optional: false, upload: false, submitStep: false },
  { instruction: FIRST_NAME_STEP, optional: false, upload: false, submitStep: false },
  { instruction: LAST_NAME_STEP, optional: false, upload: false, submitStep: false },
  { instruction: UPLOAD_STEP, optional: false, upload: true, submitStep: false },
  { instruction: SUBMIT_STEP, optional: false, upload: false, submitStep: true },
];

/**
 * Advances the fake clock in small increments until `promise` settles (or
 * `MAX_ADVANCE_ITERATIONS` is exhausted), then stops — NOT a fixed number of
 * ticks. Over-advancing past settlement would inflate the `Date.now()`-based
 * elapsed measurements the test takes immediately after, since the fake clock
 * has no notion of "idle" and just keeps advancing however far it's told to.
 */
async function advanceUntilSettled(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  for (let i = 0; i < MAX_ADVANCE_ITERATIONS && !settled; i++) {
    await vi.advanceTimersByTimeAsync(ADVANCE_STEP_MS);
  }
}

/** Matches {@link formatStepPrefix}'s `step ${n}/${total}` output at the start of a flow log line. */
const STEP_LOG_PREFIX_PATTERN = /^step (\d+)\/\d+/;

/** Reads a boundary the caller has already confirmed exists (`toBeDefined` runs before every call site) without a non-null assertion. */
function requireBoundary(boundaries: readonly (number | undefined)[], index: number): number {
  const value = boundaries[index];
  if (value === undefined) {
    throw new Error(`missing step boundary at index ${index}`);
  }
  return value;
}

/**
 * Records, per 1-indexed step number, the virtual `Date.now()` at that step's
 * FIRST log line — the moment `executeStepWithHealing` starts doing real work
 * for that step (the preceding `resolveFrameTarget`/`waitForChildFrameReady`
 * calls register no fake timer in this fixture, so they cost ~0 virtual time).
 * A wrapped `logger.info` rather than a `runHealingFlow` param: the function
 * has no per-step timing hook, so the step-prefixed log lines every step
 * already emits (`formatStepPrefix`) are the only per-step boundary available
 * without changing production code out of this subtask's scope.
 */
function makeStepStartRecorder(): { onInfo: (msg: string) => void; startedAt: number[] } {
  const startedAt: number[] = [];
  return {
    onInfo: (msg: string) => {
      const match = STEP_LOG_PREFIX_PATTERN.exec(msg);
      if (!match) return;
      const stepNumber = Number(match[1]);
      if (startedAt[stepNumber - 1] === undefined) {
        startedAt[stepNumber - 1] = Date.now();
      }
    },
    startedAt,
  };
}

describe("flow-runner dense OOPIF acceptance regression under measured latency (uchealth-7, fake timers)", () => {
  beforeEach(() => {
    loggerStub.warn.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clicks 'Manual Application', fills both name fields, and reaches a verified submit with every step's own round trips staying inside STEP_WATCHDOG_MS", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const state: AcceptanceLatencyState = {
      fileInputCount: 1,
      uploadedFileName: null,
      submitted: false,
    };
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    const order = buildDenseHopOrder();
    expect(order).toHaveLength(371);
    const hop = registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, order);
    // Both the batched fast path AND its legacy fallback are charged the
    // SAME measured round-trip cost — see this file's docblock for why that
    // makes the budget assertion below a real regression pin rather than a
    // vacuous one.
    registerDeepLocatorHopLatency(hop, {
      delayOn: [
        "scan",
        "clickByIndex",
        "fillByIndex",
        "click",
        "textContent",
        "fill",
        "selectOption",
        "inputValue",
      ],
      delayMs: MEASURED_DELEGATE_ROUND_TRIP_MS,
    });
    const targetIndex = order.length - 1;
    const firstNameIndex = findElementIndex(order, "First Name");
    const lastNameIndex = findElementIndex(order, "Last Name");
    const submitIndex = findElementIndex(order, "Submit");

    const stagehand = makeDenseStagehand();
    const { page, clickByIndexSpy, fillByIndexSpy } = makeDenseTopPage(
      topUrl,
      childUrls,
      deepLocatorFrame,
      state,
      targetIndex,
      submitIndex
    );

    const stepStartRecorder = makeStepStartRecorder();
    const startedAtMs = Date.now();
    const resultPromise = runHealingFlow({
      stagehand,
      page,
      steps: ACCEPTANCE_STEPS,
      logger: {
        info: stepStartRecorder.onInfo,
        warn: () => {},
        error: () => {},
        debug: () => {},
      } as unknown as Logger,
      anthropic: null,
      resumeFixture: {
        buffer: Buffer.from("pdf-bytes"),
        name: "resume.pdf",
        mimeType: "application/pdf",
      },
      frameSelector: IFRAME_SELECTOR,
      submittedStateSelectors: [SUBMITTED_STATE_SELECTOR],
    });

    await advanceUntilSettled(resultPromise);
    const result = await resultPromise;
    const finishedAtMs = Date.now();

    expect(result.lastStepIndex).toBe(ACCEPTANCE_STEPS.length - 1);
    expect(result.submitStepSkipped).toBe(false);
    expect(result.submitVerified).toBe(true);

    // Every step's OWN elapsed virtual time — not the whole sequence's total
    // — stays inside a single step's budget: `STEP_WATCHDOG_MS` bounds each
    // `withWatchdog`-wrapped operation within a step (`flow-runner.ts`), not
    // the cumulative 5-step run, so the boundary the bug report's acceptance
    // line actually constrains is per step. Boundaries are the first log line
    // each step emits (`formatStepPrefix`); the last step's window runs to
    // the flow's own completion.
    const stepBoundaries = [startedAtMs, ...stepStartRecorder.startedAt.slice(1), finishedAtMs];
    for (let stepNumber = 1; stepNumber <= ACCEPTANCE_STEPS.length; stepNumber++) {
      expect(stepStartRecorder.startedAt[stepNumber - 1]).toBeDefined();
      const stepElapsedMs =
        requireBoundary(stepBoundaries, stepNumber) -
        requireBoundary(stepBoundaries, stepNumber - 1);
      expect(stepElapsedMs).toBeLessThan(STEP_WATCHDOG_MS);
    }

    // No watchdog fired and no candidate walk degraded to the legacy
    // per-index fallback or aborted enumeration — the batched fast path
    // carried the whole run.
    expect(loggerStub.warn).not.toHaveBeenCalledWith(
      expect.stringMatching(/degrading to delegate|timed out after|enumeration.*aborted/i)
    );

    // Every actuation resolved through the batched seams this fixture
    // wires, at the exact indexes the fixture placed each target — not a
    // decoy, not a filler node.
    expect(clickByIndexSpy).toHaveBeenCalledWith(targetIndex);
    expect(clickByIndexSpy).toHaveBeenCalledWith(submitIndex);
    expect(fillByIndexSpy).toHaveBeenCalledWith(firstNameIndex, "Jane");
    expect(fillByIndexSpy).toHaveBeenCalledWith(lastNameIndex, "Doe");
    expect(hop.elements[firstNameIndex]?.filledWith).toBe("Jane");
    expect(hop.elements[lastNameIndex]?.filledWith).toBe("Doe");
    expect(hop.elements[targetIndex]?.clicks).toBeGreaterThan(0);
    expect(hop.elements[submitIndex]?.clicks).toBeGreaterThan(0);
    expect(state.uploadedFileName).toBe("resume.pdf");
    expect(state.submitted).toBe(true);
    expect(childUrls.current).toBe(THANK_YOU_URL);
  }, 120_000);
});
