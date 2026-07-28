import { beforeEach, describe, expect, it, vi } from "vitest";

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
  makeFakeFrameScan,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
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
