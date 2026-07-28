import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `deep-locator-candidates.ts` (and `frame-target.ts`) log via their own
// module-scoped `getLogger({name})` instance, NOT via `runHealingFlow`'s
// `logger` dependency — so the "enumeration ... aborted" / "dropped N
// unrendered candidate(s)" warnings this test pins can only be observed by
// intercepting `@/lib/logging` itself, the same seam
// `deep-locator-candidates.enumeration-throughput.test.ts` already uses.
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
 * Offline acceptance regression for the uchealth-7 bug report's own
 * acceptance test, run end to end through the REAL `runHealingFlow` /
 * `resolveFrameTarget` / `guardedObserve` / `resolveDeepLocatorCandidates`
 * stack (only Stagehand and Playwright's `Page`/`Frame` are faked) — the
 * same "acceptance-grade" composition `flow-runner.iframe-e2e.test.ts`'s
 * "full acceptance sequence" block and `flow-runner.oopif-candidate-ranking.test.ts`
 * already establish. Kept in its own file (not appended to either of those)
 * so a 371-element fixture doesn't bloat `flow-runner.iframe-e2e.test.ts`
 * and so a failure here names the run-7 regression directly.
 *
 * Reproduces the measured live shape: `#talemetry_apply_iframe >> *` matches
 * 371 elements — almost all structural filler, plus a handful of interactive
 * controls, two of which (decoys) have no layout box (a responsive wizard's
 * hidden breakpoint variant) — with "Manual Application" LAST in DOM order.
 * DOM-order-last is deliberate: it is what makes a passing run attributable
 * to the ranked cascade rather than DOM-order luck (same falsifier the
 * candidate-ranking suite already uses).
 *
 * `observe()` is blind (`[]`) for EVERY frame-scoped instruction, not just the
 * click — the field condition the whole deepLocator module exists for is that
 * `observe()` cannot see into the cross-origin OOPIF at all, not selectively.
 * The First/Last Name fill targets and the Submit control are therefore also
 * elements of the SAME dense hop, actuated through `fillDeepLocatorCandidate`/
 * `clickDeepLocatorCandidate` (bugfix-003's frame-scoped fill/select routing)
 * rather than Stagehand's own resolved `act()`, with the fill readback
 * flowing through the fake deepLocator delegate's `filledWith` recording
 * (and, for `verifyDomEffect`'s own DOM re-read, through
 * `state.filledWith` keyed by the exact `deeplocator=...>>nth=N` selector
 * `resolvedAction.selector` carries) instead of the old object-form `act()`
 * shortcut.
 */

const TOP_ORIGIN = "https://careers.uchealth.org";
const CHILD_ORIGIN = "https://apply.talemetry.com";
const IFRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123`;
/** The cascade's actual hop (`flow-runner.ts` scopes the observe-act fallback to `INTERACTIVE_CANDIDATE_SELECTOR`, not `"*"`) — must match so the fake's registered elements resolve at the same selector the cascade clicks through. */
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
const THANK_YOU_URL = `${CHILD_ORIGIN}/application/abc-123/thank-you`;
const SUBMITTED_STATE_SELECTOR = "[data-testid=thank-you]";
/** The report's real post-submit intermediate: the submit click lands the OOPIF on a GraphQL-style transition URL before it detaches, not directly on a child-origin thank-you page. */
const GQ_URL = `${CHILD_ORIGIN}/application/abc-123/gq`;
/** The report's real post-submit surface: the TOP window, not the child frame, ends up on the site's own thank-you page once the OOPIF tears down. */
const TOP_THANK_YOU_URL = `${TOP_ORIGIN}/pages/thank-you`;

/** Verbatim step instruction from the bug report's flow, naming the target and negating every decoy in one "Do NOT click" clause. */
const MANUAL_APPLICATION_STEP =
  "In the application widget, click the 'Manual Application' button to skip the resume-upload flow entirely. Do NOT click 'Upload a Resume/CV', 'Use LinkedIn Profile', 'Upload From Dropbox', or 'Upload From OneDrive'.";
/**
 * The field label is quoted alongside the fill value so
 * `resolveDeepLocatorCandidates`'s phrase-based ranking (`deep-locator-
 * candidates.ts`'s `scoreCandidate`) has something to score the "First Name"
 * candidate's accessible name against — with only the value quoted (as a
 * bare "Fill in First Name" step would parse), every candidate in a dense
 * hop ties at score 0 and the walk falls back to DOM order, which is exactly
 * the DOM-order-luck this fixture's decoy design exists to rule out.
 * `parseFillStep` (`flow-runner.ts`) still extracts the value correctly: its
 * `with\s+'([^']+)'` match anchors on the LAST quoted phrase, so the extra
 * leading quote doesn't change what gets typed.
 */
const FIRST_NAME_STEP = "Fill in the 'First Name' field with 'Jane'";
const LAST_NAME_STEP = "Fill in the 'Last Name' field with 'Doe'";
const UPLOAD_STEP = "Upload resume";
const SUBMIT_STEP = "Click the final 'Submit' button";

/**
 * Accessible names for the fill/submit targets living inside the SAME dense
 * hop as "Manual Application" — a real `<input>`/`<button>` has empty
 * `textContent` per the DOM spec, so in the live DOM these names would come
 * from `aria-label`/an associated `<label>`/`placeholder`
 * (`buildAccessibleNameExpr`, `deep-locator-scan.ts`), never from
 * `textContent`. The fake's single `text` field already models the
 * COMPUTED accessible name (see `FakeDeepLocatorElement`'s docstring), so no
 * separate raw-textContent field is needed to keep that distinction real.
 */
const FIRST_NAME_ELEMENT: FakeDeepLocatorElementSpec = { text: "First Name" };
const LAST_NAME_ELEMENT: FakeDeepLocatorElementSpec = { text: "Last Name" };
const SUBMIT_ELEMENT: FakeDeepLocatorElementSpec = { text: "Submit" };

/** Unscoped/top-frame observe result — never the right candidate for any frame-scoped step, matching every sibling fixture's "wrong list if scoping is lost" shape. */
const TOP_FRAME_CANDIDATES = [
  { selector: "css=nav a.careers-home", description: "Careers home link", method: "click" },
  { selector: "css=button.share-linkedin", description: "Share on LinkedIn", method: "click" },
  { selector: "css=button#apply-now", description: "Apply now button", method: "click" },
];

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/**
 * The four verbatim negated decoys from the bug report's flow instruction.
 * Two are rendered and two are layout-less duplicates — a responsive
 * wizard's hidden breakpoint variant — reproducing the run-7 "some
 * candidates have no layout box" condition. Visibility never changes a
 * decoy's ranking (negated phrases always score below the real target,
 * rendered or not); what it proves is that the batched scan drops them
 * before the cascade ever considers clicking one.
 */
const DECOYS: FakeDeepLocatorElementSpec[] = [
  { text: "Upload a Resume/CV", visible: true },
  { text: "Use LinkedIn Profile", visible: false },
  { text: "Upload From Dropbox", visible: true },
  { text: "Upload From OneDrive", visible: false },
];

/** Filler-block sizes (structural, empty-text, rendered nodes) that sum to 363 — with the 4 decoys, the 3 fill/submit targets, and the real target, 371 total, matching the live-measured `"*"` match count. */
const FILLER_BLOCK_SIZES = [99, 99, 99, 66];

/**
 * The First/Last Name fill targets and the Submit control, interspersed one
 * per filler block (mirroring `DECOYS`' placement) rather than appended
 * separately — they are genuinely part of the SAME 371-node hop the
 * "Manual Application" click resolves against, not a distinct form the
 * fixture models on its own. `undefined` for the last block keeps the total
 * element count aligned with `DECOYS`' 4-entry placement.
 */
const FORM_FIELD_ELEMENTS: ReadonlyArray<FakeDeepLocatorElementSpec | undefined> = [
  FIRST_NAME_ELEMENT,
  LAST_NAME_ELEMENT,
  SUBMIT_ELEMENT,
  undefined,
];

/**
 * Builds the 371-element (370 without the target) DOM-order array a `"*"`
 * hop over the dense Talemetry wizard resolves to: filler blocks with the
 * four decoys and the three fill/submit targets interspersed between them,
 * and — when `includeTarget` — the real "Manual Application" button LAST.
 */
function buildDenseHopOrder(includeTarget: boolean): Array<string | FakeDeepLocatorElementSpec> {
  const order: Array<string | FakeDeepLocatorElementSpec> = [];
  for (const [index, size] of FILLER_BLOCK_SIZES.entries()) {
    order.push(...Array.from({ length: size }, () => ""));
    const decoy = DECOYS[index];
    if (decoy) order.push(decoy);
    const formField = FORM_FIELD_ELEMENTS[index];
    if (formField) order.push(formField);
  }
  if (includeTarget) order.push("Manual Application");
  return order;
}

/** Position of the first element whose accessible name is `text` — used to locate the First/Last Name/Submit targets within `buildDenseHopOrder`'s array without hand-tracking their index through the filler/decoy interleaving. */
function findElementIndex(
  order: ReadonlyArray<string | FakeDeepLocatorElementSpec>,
  text: string
): number {
  return order.findIndex((entry) => typeof entry !== "string" && entry.text === text);
}

/** In-memory model of the fields the acceptance sequence fills/uploads/submits inside the OOPIF, mirroring `flow-runner.iframe-e2e.test.ts`'s `AcceptanceSequenceState`. */
interface AcceptanceSequenceState {
  filledWith: Map<string, string>;
  fileInputCount: number;
  uploadedFileName: string | null;
  submitted: boolean;
}

/**
 * Child `Frame` fake: `location.href`/`document.readyState`/fill-readback/
 * upload/submitted-state probes mirror `flow-runner.iframe-e2e.test.ts`'s
 * `makeAcceptanceChildFrame` exactly, plus one addition — an `evaluate` call
 * whose expression contains `isVisible` (the batched
 * `buildScanFrameCandidatesExpr` marker, `deep-locator-scan.ts`) resolves
 * via `makeFakeFrameScan`, so `resolveDeepLocatorCandidates`'s batched-scan
 * fast path (bugfix-002, already shipped) actually runs against this
 * fixture's 371-element hop instead of falling back to the legacy loop.
 * `detached` models the OOPIF tearing down right after a submit click:
 * every `evaluate` call (including the `location.href` read `FrameTarget.url()`
 * makes) rejects the same way a live cross-origin CDP frame session does once
 * its frame detaches, exercising `snapshotPage`'s `page.url()` fallback
 * (`flow-runner.submit-verify-frame-scope.test.ts` pins the same seam).
 */
function makeDenseChildFrame(
  childUrls: { current: string },
  state: AcceptanceSequenceState,
  deepLocatorFrame: FakeDeepLocatorFrame,
  detached: { current: boolean }
) {
  const scan = makeFakeFrameScan(deepLocatorFrame, HOP_SELECTOR);
  return {
    evaluate: async (expr: unknown) => {
      if (detached.current) throw new Error("Execution context was destroyed");
      const src = String(expr);
      if (src === "location.href") return childUrls.current;
      if (src === "document.readyState") return "complete";
      if (src.includes("isVisible")) return scan();
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
    locator: (selector: string) => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => state.filledWith.get(selector) ?? "",
        setInputFiles: async (file: { name: string }) => {
          state.uploadedFileName = file.name;
        },
      }),
    }),
  };
}

/**
 * Models the report's real post-submit surface instead of a same-origin
 * child thank-you page: the submit click first lands the OOPIF on an
 * intermediate `.../gq` URL, then the child frame detaches (its `evaluate`
 * calls start rejecting and it drops out of `page.frames()`) while the TOP
 * window navigates to the site's own thank-you page. Omitted, the submit
 * click takes the older direct child-origin-thank-you shortcut.
 */
interface PostSubmitDetachConfig {
  /** Intermediate child-frame URL the submit lands on before the OOPIF tears down. */
  gqUrl: string;
  /** Top-window URL the site's real post-submit navigation lands on. */
  topThankYouUrl: string;
}

/**
 * Fake two-frame `Page`. `deepLocator(...).nth(index).click()` only
 * navigates the child frame to the basic-info page when `index` is
 * `targetIndex` (the "Manual Application" button's position), and only
 * marks the run submitted (thank-you URL + `state.submitted`) when `index`
 * is `submitIndex` — every other index (a decoy, a layout-less duplicate, or
 * filler) either throws `NODE_NOT_ACTIONABLE_MESSAGE` (unrendered) or
 * resolves as a no-op click with zero downstream effect. That per-index
 * discrimination is what makes a passing "urlChanged" verification signal
 * attributable to clicking the CORRECT element, not just attributable to
 * "some click happened" (the gap the single-element `registerDeepLocatorHop`
 * fixtures elsewhere in this suite family don't need to close, since they
 * only ever register one candidate). `targetIndex: null` (the negative
 * control) means no index ever navigates to basic-info. When `postSubmitDetach`
 * is set, the submit click drives the report's real sequence (`.../gq` +
 * frame detach + top-window navigation) instead of a direct child-origin
 * thank-you transition.
 *
 * `deepLocator(...).nth(index).fill(value)` records `value` on the fake
 * delegate's own per-element `filledWith` (bugfix-002's fake extension,
 * `deep-locator-fake.ts`) AND on `state.filledWith`, keyed by the exact
 * `deeplocator=...>>nth=N` selector `resolvedAction.selector` carries — the
 * same key `makeDenseChildFrame`'s `locator(selector).first().inputValue()`
 * reads back, so `flow-runner.ts`'s own `verifyDomEffect` (not just this
 * test's assertions) sees the fill and marks the step verified.
 */
function makeDenseTopPage(
  topUrl: { current: string },
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame,
  state: AcceptanceSequenceState,
  targetIndex: number | null,
  submitIndex: number,
  postSubmitDetach: PostSubmitDetachConfig | null = null
) {
  const session = { on: () => {}, off: () => {} };
  const detached = { current: false };
  const childFrame = makeDenseChildFrame(childUrls, state, deepLocatorFrame, detached);
  const fakeDeepLocator = makeFakeDeepLocator(deepLocatorFrame);
  const wrappedDeepLocator = (selector: string) => {
    const delegate = fakeDeepLocator(selector);
    return {
      ...delegate,
      nth: (index: number) => {
        const nthDelegate = fakeDeepLocator(selector).nth(index);
        return {
          ...nthDelegate,
          click: async () => {
            await nthDelegate.click();
            if (targetIndex !== null && index === targetIndex) {
              childUrls.current = `${CHILD_ORIGIN}/application/abc-123/basic-info`;
            }
            if (index === submitIndex) {
              state.submitted = true;
              if (postSubmitDetach) {
                childUrls.current = postSubmitDetach.gqUrl;
                detached.current = true;
                topUrl.current = postSubmitDetach.topThankYouUrl;
              } else {
                childUrls.current = THANK_YOU_URL;
              }
            }
          },
          fill: async (value: string) => {
            await nthDelegate.fill(value);
            state.filledWith.set(`deeplocator=${selector} >> nth=${index}`, value);
          },
        };
      },
    };
  };
  return {
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
    frames: () => (detached.current ? [] : [childFrame]),
    deepLocator: wrappedDeepLocator,
  } as unknown as import("@browserbasehq/stagehand").Page;
}

/**
 * Fake `Stagehand`: `observe()` is blind (`[]`) for EVERY frame-scoped
 * instruction — the "Manual Application" click, the First/Last Name fills,
 * and the Submit click alike — across every scoping (focused, unfocused,
 * and — via the shared fallthrough — top-frame), forcing every frame-scoped
 * step through the `resolveDeepLocatorCandidates` fallback under test. That
 * is the actual field condition the bug report names: `observe()` cannot
 * see into the cross-origin OOPIF at all, not selectively for one step. A
 * fixture where every OTHER frame-scoped step resolved normally via
 * Stagehand's own `act()` would let a missing frame-scoped fill/select
 * routing path go unnoticed — which is exactly what happened before
 * bugfix-001–003 landed. `act(instruction: string)` (attempt 1, every step)
 * always phantom-fails, forcing every step through attempt 2's
 * observe-act/deepLocator path.
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
      if (!isFrameScoped) return TOP_FRAME_CANDIDATES;
      // Every frame-scoped instruction — focused, unfocused, click, fill,
      // select alike — falls through here blind, by design.
      return [];
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

describe("flow-runner dense OOPIF acceptance regression (uchealth-7, offline fixture, no network)", () => {
  beforeEach(() => {
    loggerStub.warn.mockClear();
  });

  it("clicks 'Manual Application' — last of 371 candidates — over four decoys (two layout-less) and 366 filler nodes, then carries frame scope through fill -> upload -> a verified submit", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const state: AcceptanceSequenceState = {
      filledWith: new Map(),
      fileInputCount: 1,
      uploadedFileName: null,
      submitted: false,
    };
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    const order = buildDenseHopOrder(true);
    expect(order).toHaveLength(371);
    const hop = registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, order);
    const targetIndex = order.length - 1;
    const firstNameIndex = findElementIndex(order, "First Name");
    const lastNameIndex = findElementIndex(order, "Last Name");
    const submitIndex = findElementIndex(order, "Submit");

    const stagehand = makeDenseStagehand();
    const page = makeDenseTopPage(
      topUrl,
      childUrls,
      deepLocatorFrame,
      state,
      targetIndex,
      submitIndex
    );

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: ACCEPTANCE_STEPS,
      logger: SILENT_LOGGER,
      anthropic: null,
      resumeFixture: {
        buffer: Buffer.from("pdf-bytes"),
        name: "resume.pdf",
        mimeType: "application/pdf",
      },
      frameSelector: IFRAME_SELECTOR,
      submittedStateSelectors: [SUBMITTED_STATE_SELECTOR],
    });

    expect(result.lastStepIndex).toBe(ACCEPTANCE_STEPS.length - 1);
    expect(result.submitStepSkipped).toBe(false);
    expect(result.submitVerified).toBe(true);

    // Only the real, last-in-DOM-order button and the Submit control were
    // ever clicked — not a decoy, not a layout-less duplicate, not a filler
    // node, and not the First/Last Name fields (those were filled, not
    // clicked).
    expect(hop.elements[targetIndex]?.clicks).toBeGreaterThan(0);
    expect(hop.elements[submitIndex]?.clicks).toBeGreaterThan(0);
    for (const [index, element] of hop.elements.entries()) {
      if (index === targetIndex || index === submitIndex) continue;
      expect(element.clicks).toBe(0);
    }

    // Both name fields were filled via the deepLocator fill actuation path
    // (`fillDeepLocatorCandidate`), not Stagehand's `act()` — the fake
    // delegate's own `filledWith` recording proves the actuation, and
    // `result.submitVerified`/`result.lastStepIndex` above already prove
    // `verifyDomEffect`'s DOM re-read accepted it as verified.
    expect(hop.elements[firstNameIndex]?.filledWith).toBe("Jane");
    expect(hop.elements[lastNameIndex]?.filledWith).toBe("Doe");
    expect(state.uploadedFileName).toBe("resume.pdf");
    expect(state.submitted).toBe(true);
    expect(childUrls.current).toBe(THANK_YOU_URL);

    // Issue #1: the batched single-round-trip scan enumerated all 371
    // candidates without exceeding the legacy loop's abort budget.
    expect(loggerStub.warn).not.toHaveBeenCalledWith(
      expect.stringMatching(/enumeration.*aborted/i)
    );
    // Issue #2: the two layout-less decoys were dropped by the resolver's
    // visibility filter BEFORE any click was attempted against them — proof
    // the -32000 "no layout object" failure never had a chance to fire.
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringMatching(/dropped 2 unrendered candidate/)
    );
    expect(loggerStub.warn).not.toHaveBeenCalledWith(expect.stringMatching(/-32000/));
  });

  it("drives the same 371-candidate dense hop through to the report's real post-submit surface: an intermediate child '.../gq' URL, then the OOPIF detaches while the TOP window lands on the careers thank-you page", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const state: AcceptanceSequenceState = {
      filledWith: new Map(),
      fileInputCount: 1,
      uploadedFileName: null,
      submitted: false,
    };
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    const order = buildDenseHopOrder(true);
    expect(order).toHaveLength(371);
    const hop = registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, order);
    const targetIndex = order.length - 1;
    const firstNameIndex = findElementIndex(order, "First Name");
    const lastNameIndex = findElementIndex(order, "Last Name");
    const submitIndex = findElementIndex(order, "Submit");

    const stagehand = makeDenseStagehand();
    const page = makeDenseTopPage(
      topUrl,
      childUrls,
      deepLocatorFrame,
      state,
      targetIndex,
      submitIndex,
      { gqUrl: GQ_URL, topThankYouUrl: TOP_THANK_YOU_URL }
    );

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: ACCEPTANCE_STEPS,
      logger: SILENT_LOGGER,
      anthropic: null,
      resumeFixture: {
        buffer: Buffer.from("pdf-bytes"),
        name: "resume.pdf",
        mimeType: "application/pdf",
      },
      frameSelector: IFRAME_SELECTOR,
      submittedStateSelectors: [SUBMITTED_STATE_SELECTOR],
    });

    expect(result.lastStepIndex).toBe(ACCEPTANCE_STEPS.length - 1);
    expect(result.submitStepSkipped).toBe(false);
    expect(result.submitVerified).toBe(true);

    // Same click/fill/upload attribution as the sibling case — this test
    // isolates the post-submit surface, not the enumeration/actuation path
    // those assertions already cover.
    expect(hop.elements[targetIndex]?.clicks).toBeGreaterThan(0);
    expect(hop.elements[submitIndex]?.clicks).toBeGreaterThan(0);
    for (const [index, element] of hop.elements.entries()) {
      if (index === targetIndex || index === submitIndex) continue;
      expect(element.clicks).toBe(0);
    }
    expect(hop.elements[firstNameIndex]?.filledWith).toBe("Jane");
    expect(hop.elements[lastNameIndex]?.filledWith).toBe("Doe");
    expect(state.uploadedFileName).toBe("resume.pdf");
    expect(state.submitted).toBe(true);

    // The report's actual sequence: the child frame lands on the
    // intermediate `.../gq` URL (never a child-origin thank-you page — that
    // would be the fixture-convention shortcut this case exists to rule
    // out), and the TOP window — not the child frame — is what reaches the
    // real success surface.
    expect(childUrls.current).toBe(GQ_URL);
    expect(childUrls.current).not.toBe(THANK_YOU_URL);
    expect(topUrl.current).toBe(TOP_THANK_YOU_URL);
    // `page.url()` is exactly what `snapshotPage`'s `page` fallback reads
    // once the resolved child `FrameTarget.url()` rejects on the detached
    // OOPIF — asserting through it (not just the `topUrl` ref) proves the
    // submit was verified via that fallback, not a stale pre-detach read.
    expect(page.url()).toBe(TOP_THANK_YOU_URL);

    // Issue #1/#2 regressions still hold with the report's real post-submit
    // surface wired in: the batched scan still enumerates the full 371-node
    // hop within budget, and the two layout-less decoys are still dropped
    // before any click is attempted against them.
    expect(loggerStub.warn).not.toHaveBeenCalledWith(
      expect.stringMatching(/enumeration.*aborted/i)
    );
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringMatching(/dropped 2 unrendered candidate/)
    );
    expect(loggerStub.warn).not.toHaveBeenCalledWith(expect.stringMatching(/-32000/));
  });

  it("negative control: with 'Manual Application' absent from the same 370-node hop, the click step exhausts the cascade and the run never reaches fill/upload/submit", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const state: AcceptanceSequenceState = {
      filledWith: new Map(),
      fileInputCount: 0,
      uploadedFileName: null,
      submitted: false,
    };
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    const order = buildDenseHopOrder(false);
    expect(order).toHaveLength(370);
    registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, order);
    const submitIndex = findElementIndex(order, "Submit");

    const stagehand = makeDenseStagehand();
    // No element ever matches "Manual Application", so no index should ever
    // be treated as the target — targetIndex: null makes every click a no-op.
    const page = makeDenseTopPage(topUrl, childUrls, deepLocatorFrame, state, null, submitIndex);

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: ACCEPTANCE_STEPS,
        logger: SILENT_LOGGER,
        anthropic: null,
        resumeFixture: {
          buffer: Buffer.from("pdf-bytes"),
          name: "resume.pdf",
          mimeType: "application/pdf",
        },
        frameSelector: IFRAME_SELECTOR,
        submittedStateSelectors: [SUBMITTED_STATE_SELECTOR],
      })
    ).rejects.toThrow(/cascade|attempts|verification|candidates/i);

    // Attributable to the click step specifically: no fill, no upload, no
    // submit ever ran, and the child frame never left its initial URL.
    expect(state.filledWith.size).toBe(0);
    expect(state.uploadedFileName).toBeNull();
    expect(state.submitted).toBe(false);
    expect(childUrls.current).toBe(CHILD_SRC);
  });
});

/**
 * Measured cost of one delegate round-trip through Browserbase's proxied CDP
 * into the cross-origin OOPIF (uchealth-7's `13/371 candidates enumerated in
 * 60s` measurement) — same constant `flow-runner.oopif-click-throughput.test.ts`
 * uses.
 */
const MEASURED_DELEGATE_ROUND_TRIP_MS = 4_600;

/** Fake-timer advance granularity: many small ticks (not a few large jumps) so `advanceTimersByTimeAsync` — which only drains a bounded number of microtask turns per call — gives the real `runHealingFlow`/`resolveFrameTarget`/`resolveDeepLocatorCandidates` await chain enough chances to fully settle between each timer step, the same reason `flow-runner.oopif-hang-watchdog.test.ts` ticks in 1s increments rather than one large jump. */
const ADVANCE_STEP_MS = 1_000;
/** Matches `flow-runner.oopif-hang-watchdog.test.ts`'s `advancePastDeepLocatorHangs` budget — comfortably above the ~5 attempts-worth of round trips this fixture's steps (with retries) can accumulate. */
const MAX_ADVANCE_ITERATIONS = 300;

/** In-memory model of the fields the latency-charged run uploads/submits inside the OOPIF — no `filledWith` map needed here (unlike `AcceptanceSequenceState` above): the fill/select actuators' own write-then-read-back IS the verification signal for the deepLocator field-target branch (`flow-runner.ts`'s `verifyDomEffect` never resolves a `deeplocator=` selector), so the fake hop's own per-element `filledWith` (asserted below) is sufficient. */
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
 * Fake child `Frame` for the latency-charged run: routes `buildScanFrameCandidatesExpr`'s
 * (marker: `accessibleName(el)`), `buildClickFrameCandidateExpr`'s (marker: `mousedown`), and
 * `buildFillFrameCandidateExpr`'s (marker: `HTMLInputElement.prototype`) evaluate calls to the
 * shared deepLocator-fake's batched seams — the one-round-trip paths `deep-locator-candidates.ts`'s
 * `clickCandidateBatched` and `deep-locator-actuate.ts`'s `actuateCandidateBatched` take when a
 * frame seam is available, replacing the zero-cost `makeDenseChildFrame` above's page-level legacy
 * `nth(index).fill()`/`.click()` override. No `buildSelectFrameCandidateOptionExpr` routing: this
 * fixture has no `<select>` step, so wiring one would be dead code.
 */
function makeBatchedChildFrame(
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
 * Fake two-frame `Page` for the latency-charged run. `deepLocator` is wired to the shared fake's
 * unwrapped legacy delegate — `resolveDeepLocatorCandidates` constructs it unconditionally
 * (`typeof page.deepLocator === "function" ? page.deepLocator(hopSelector) : null`) even when the
 * batched scan succeeds, so it must exist and stay callable, but with every step routed through
 * `makeBatchedChildFrame`'s batched seams it is never actually invoked for a click/fill/enumeration
 * round-trip on the happy path this test drives.
 */
function makeBatchedTopPage(
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
  } = makeBatchedChildFrame(childUrls, state, deepLocatorFrame, targetIndex, submitIndex);
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

/**
 * Latency-charged counterpart to the zero-cost acceptance run above: the SAME
 * 371-node dense-OOPIF-shaped hop, driven through the REAL `runHealingFlow`
 * stack, but with every round-trip a real cross-origin CDP call would pay —
 * the batched scan, the batched click/fill actuations, AND the legacy
 * per-index fallbacks they replace — charged the uchealth-7 bug report's own
 * measured cost (`MEASURED_DELEGATE_ROUND_TRIP_MS`, matching `flow-runner.
 * oopif-click-throughput.test.ts`'s constant) under fake timers, scoped to
 * this describe block only so the zero-cost tests above stay on real timers.
 * The zero-cost run above proves ranking/visibility/routing; this run proves
 * the bug report's own acceptance line — "found + clicked within the
 * per-step budget ... proceeds through the in-frame fills to a verified
 * submit" — by pinning that every step's actuation still lands inside
 * `STEP_WATCHDOG_MS` once real latency is on the clock.
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
    const order = buildDenseHopOrder(true);
    expect(order).toHaveLength(371);
    const hop = registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, order);
    // Both the batched fast path AND its legacy fallback are charged the
    // SAME measured round-trip cost — see this describe block's docblock for
    // why that makes the budget assertion below a real regression pin rather
    // than a vacuous one.
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
    const { page, clickByIndexSpy, fillByIndexSpy } = makeBatchedTopPage(
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
