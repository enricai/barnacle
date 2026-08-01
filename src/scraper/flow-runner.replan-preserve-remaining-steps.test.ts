import { describe, expect, it } from "vitest";
import {
  type FakeDeepLocatorElementSpec,
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHopElements,
} from "@/scraper/deep-locator-fake";
import { INTERACTIVE_CANDIDATE_SELECTOR } from "@/scraper/deep-locator-scan";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Offline acceptance regression for Barnacle follow-up #10 (UCHealth
 * recon-19/-20): a view-swap "reveal" step (Basic Info's Next click,
 * measured +789B DOM growth, zero network) used to be scored a failure and
 * trigger a global replan that DISCARDED the author's entire remaining
 * Work-History entry-fill sub-sequence (`originalRemaining: 24 steps ->
 * newRemaining: 1 step`), producing a duplicate "Add New Work History"
 * click, a fill against a now-closed entry form, and a "Requires Attention"
 * entry.
 *
 * **What this pins:** `isClickViewSwapVerified`'s scoped reveal-credit gate
 * (bugfix-001, `flow-runner.ts`) crediting the +789B/textChanged Next click
 * as a verified step outcome — so no replan ever fires for it, the
 * author's authored Work-History entry-fill steps (Add, Company Name, Job
 * Title, Description, Start Date, Current, Done) run exactly once each, in
 * order, against the entry form they opened, the completed entry is never
 * re-toggled closed, and the run advances cleanly through Next into
 * Education History and on to a verified submit. `runHealingFlow` itself
 * never splices a replan bridge (that lives in `recon-browser.ts`'s
 * offline `main()`, pinned separately by
 * `recon-browser.ts`'s `filterReplanDuplicatingNextAuthored` unit suite,
 * bugfix-002) — the credited-reveal path is what a live `runHealingFlow`
 * run can exercise end to end, and is sufficient to prove the authored
 * sub-sequence survives.
 *
 * **Structure:** Modeled directly on
 * `flow-runner.oopif-dense-form-acceptance.test.ts`'s dense-OOPIF harness
 * (`makeDenseChildFrame`/`makeDenseTopPage`/`makeDenseStagehand`,
 * `AcceptanceSequenceState`, `requireBoundary`) and
 * `flow-runner.client-side-view-swap-acceptance.test.ts`'s reveal-click DOM
 * delta wiring, extended with the authored Work-History entry-fill chain
 * and a post-Next Education History marker.
 */

const TOP_ORIGIN = "https://careers.uchealth.org";
const CHILD_ORIGIN = "https://apply.talemetry.com";
const IFRAME_SELECTOR = "iframe#talemetry_apply_iframe";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123/basic-info`;
/** The cascade's actual hop (`flow-runner.ts` scopes the observe-act fallback to `INTERACTIVE_CANDIDATE_SELECTOR`, not `"*"`) — must match so the fake's registered elements resolve at the same selector the cascade clicks through. */
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
const ENTRY_OPEN_URL = `${CHILD_ORIGIN}/application/abc-123/work-history#entry-open`;
const ENTRY_CURRENT_TOGGLED_URL = `${CHILD_ORIGIN}/application/abc-123/work-history#entry-current`;
const ENTRY_SAVED_URL = `${CHILD_ORIGIN}/application/abc-123/work-history#entry-saved`;
const EDUCATION_HISTORY_URL = `${CHILD_ORIGIN}/application/abc-123/education-history`;
const GQ_URL = `${CHILD_ORIGIN}/application/abc-123/gq`;
const TOP_THANK_YOU_URL = `${TOP_ORIGIN}/pages/thank-you`;
const SUBMITTED_STATE_SELECTOR = "[data-testid=thank-you]";

/** Verbatim step instruction naming the reveal — the exact wording the run-19/20 replan record fired the global replan against. */
const REVEAL_STEP =
  "Click the primary 'Next' button once to submit Basic Info; this triggers validation and reveals the Work History requirement";
const ADD_WH_STEP =
  "If a work history entry form with a Company Name field is NOT already open, click the 'Add New Work History' button to open it";
const COMPANY_NAME_STEP =
  "In the work history entry form, fill in the 'Company Name' field with 'General Hospital'";
const JOB_TITLE_STEP =
  "In the work history entry form, fill in the 'Job Title' field with 'Registered Nurse'";
const DESCRIPTION_STEP =
  "In the work history entry form, fill in the 'Description' field with 'Provided direct patient care'";
const START_DATE_STEP =
  "In the work history entry form, select '2020' in the 'Start Date' dropdown";
const CURRENT_STEP = "Click the 'Current' toggle in the work history entry form";
const DONE_STEP = "Click the 'Done' button to save the work history entry";
const NEXT_TO_EDUCATION_STEP = "Click the 'Next' button to advance to Education History";
const SCREENING_STEP = "Select 'Yes' in the 'Are you at least 18 years of age?' dropdown";
const SELF_ID_STEP = "Select 'Decline to self-identify' in the self-identification dropdown";
const SUBMIT_STEP = "Click the final 'Submit' button";

/** Accessible names for the Work-History entry-form controls living inside the SAME dense hop as the reveal button. */
const ADD_WH_ELEMENT: FakeDeepLocatorElementSpec = { text: "Add New Work History" };
const COMPANY_NAME_ELEMENT: FakeDeepLocatorElementSpec = { text: "Company Name" };
const JOB_TITLE_ELEMENT: FakeDeepLocatorElementSpec = { text: "Job Title" };
const DESCRIPTION_ELEMENT: FakeDeepLocatorElementSpec = { text: "Description" };
const START_DATE_ELEMENT: FakeDeepLocatorElementSpec = { text: "Start Date", tagName: "select" };
const CURRENT_ELEMENT: FakeDeepLocatorElementSpec = { text: "Current" };
const DONE_ELEMENT: FakeDeepLocatorElementSpec = { text: "Done" };
const NEXT_TO_EDUCATION_ELEMENT: FakeDeepLocatorElementSpec = { text: "Next" };
const SCREENING_QUESTION_TEXT = "Are you at least 18 years of age?";
const SCREENING_ELEMENT: FakeDeepLocatorElementSpec = {
  text: SCREENING_QUESTION_TEXT,
  tagName: "select",
};
const SELF_ID_TEXT = "self-identification dropdown";
const SELF_ID_ELEMENT: FakeDeepLocatorElementSpec = { text: SELF_ID_TEXT, tagName: "select" };
const SUBMIT_ELEMENT: FakeDeepLocatorElementSpec = { text: "Submit" };
/** The reveal button itself — DOM-order LAST among the first hop's elements, mirroring the sibling acceptance fixtures' "not DOM-order luck" convention. */
const REVEAL_ELEMENT_TEXT = "primary Next";

/** Filler-block sizes interspersing the ordered Work-History acceptance chain, matching `oopif-dense-form-acceptance.test.ts`'s filler-block convention. */
const FILLER_BLOCK_SIZE = 6;

const ORDERED_TARGETS: FakeDeepLocatorElementSpec[] = [
  { text: REVEAL_ELEMENT_TEXT },
  ADD_WH_ELEMENT,
  COMPANY_NAME_ELEMENT,
  JOB_TITLE_ELEMENT,
  DESCRIPTION_ELEMENT,
  START_DATE_ELEMENT,
  CURRENT_ELEMENT,
  DONE_ELEMENT,
  NEXT_TO_EDUCATION_ELEMENT,
  SCREENING_ELEMENT,
  SELF_ID_ELEMENT,
  SUBMIT_ELEMENT,
];

/**
 * Builds the DOM-order array a dense hop over the Talemetry wizard resolves
 * to: a filler block ahead of each ordered target, reproducing the "target
 * is never first/DOM-order-lucky" convention every sibling acceptance
 * fixture in this suite family uses.
 */
function buildDenseHopOrder(): Array<string | FakeDeepLocatorElementSpec> {
  const order: Array<string | FakeDeepLocatorElementSpec> = [];
  for (const target of ORDERED_TARGETS) {
    order.push(...Array.from({ length: FILLER_BLOCK_SIZE }, () => ""));
    order.push(target);
  }
  return order;
}

/** Position of the first element whose accessible name is `text`. */
function findElementIndex(
  order: ReadonlyArray<string | FakeDeepLocatorElementSpec>,
  text: string
): number {
  return order.findIndex((entry) => typeof entry !== "string" && entry.text === text);
}

/** In-memory model of the fields the acceptance sequence fills/selects/submits inside the OOPIF. */
interface AcceptanceSequenceState {
  filledWith: Map<string, string>;
  /** Whether the Work-History entry form is currently open — flips open on Add, closes on Done (or a second Add). */
  entryFormOpen: boolean;
  /** Set true if Add is clicked a second time while already open — the run-19/20 double-Add symptom this test exists to prove never happens. */
  entryFormReopenedOrClosedEarly: boolean;
  /** Set true only once every required Work-History field has been filled before Done is clicked — false means Done would save an incomplete ("Requires Attention") entry. */
  entryComplete: boolean;
  requiresAttention: boolean;
  submitted: boolean;
}

/** Body HTML/innerText sizes for the reveal click's measured +789B, text-changing view-swap delta. */
const PRE_REVEAL_HTML_SIZE = 42_000;
const POST_REVEAL_HTML_SIZE = PRE_REVEAL_HTML_SIZE + 789;
const PRE_REVEAL_TEXT = "1:basic-info";
const POST_REVEAL_TEXT = "1:basic-info+work-history-requirement";

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/**
 * Child `Frame` fake wiring the reveal step's DOM-only view-swap delta plus
 * the Work-History entry-form open/close/complete state machine and the
 * screening/self-ID/submit tail — mirrors `oopif-dense-form-acceptance.test
 * .ts`'s `makeDenseChildFrame` for the shared batched-scan/candidate-index
 * plumbing, with the acceptance state additionally threaded through.
 */
function makeAcceptanceChildFrame(
  childUrls: { current: string },
  state: AcceptanceSequenceState,
  deepLocatorFrame: FakeDeepLocatorFrame,
  revealed: { current: boolean },
  detached: { current: boolean }
) {
  return {
    evaluate: async (expr: unknown) => {
      if (detached.current) throw new Error("Execution context was destroyed");
      const src = String(expr);
      if (src === "location.href") return childUrls.current;
      if (src === "document.readyState") return "complete";
      if (src.includes("isVisible") && !src.includes("accessibleName")) {
        const indexMatch = CANDIDATE_INDEX_PATTERN.exec(src);
        const element = indexMatch
          ? deepLocatorFrame.get(HOP_SELECTOR)?.elements[Number(indexMatch[1])]
          : undefined;
        return element ? { value: element.filledWith ?? "" } : {};
      }
      if (src.includes("isVisible")) return makeFakeScanResult(deepLocatorFrame);
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return {
          html: revealed.current ? POST_REVEAL_HTML_SIZE : PRE_REVEAL_HTML_SIZE,
          text: revealed.current ? POST_REVEAL_TEXT : PRE_REVEAL_TEXT,
        };
      }
      if (src.includes('querySelectorAll("[class],[aria-invalid]")')) {
        return state.requiresAttention ? 1 : 0;
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
      }),
    }),
  };
}

/** Local re-implementation of the batched-scan marker dispatch `makeFakeFrameScan` performs, scoped to this fixture's single hop — kept inline so `makeAcceptanceChildFrame`'s `evaluate` can share one function signature with the rest of its branches. */
function makeFakeScanResult(deepLocatorFrame: FakeDeepLocatorFrame) {
  const hop = deepLocatorFrame.get(HOP_SELECTOR);
  if (!hop) return [];
  return hop.elements
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => element.visible)
    .map(({ element, index }) => ({
      index,
      accessibleName: element.text,
      tagName: element.tagName ?? "div",
    }));
}

/** Matches a batched click/fill expression's `matches[<index>]` candidate lookup, same convention `oopif-dense-form-acceptance.test.ts` uses. */
const CANDIDATE_INDEX_PATTERN = /matches\[(\d+)\]/;

/**
 * Fake two-frame `Page`. Click-index discrimination against the ordered
 * target indexes drives the reveal, the Work-History entry-form
 * open/close/complete state machine, the Next-to-Education-History
 * transition, and the post-submit surface — every other index (filler)
 * resolves as a no-op with zero downstream effect.
 *
 * The `Add New Work History` click is the fixture's own proof the double-Add
 * symptom never happens: a SECOND click while the form is already open sets
 * `entryFormReopenedOrClosedEarly` (the assertion this test exists to rule
 * out), matching the report's "the second Add closes it" defect.
 *
 * `Done` only completes the entry (clears `requiresAttention`) when every
 * required field (Company Name, Job Title, Description, Start Date,
 * Current) has already been filled/selected AND the form is still open —
 * exactly the "authored steps ran against an open form, in order" property
 * this test's success criteria requires.
 */
function makeAcceptanceTopPage(
  topUrl: { current: string },
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame,
  state: AcceptanceSequenceState,
  indexes: {
    reveal: number;
    add: number;
    companyName: number;
    jobTitle: number;
    description: number;
    startDate: number;
    current: number;
    done: number;
    nextToEducation: number;
    screening: number;
    selfId: number;
    submit: number;
  },
  revealed: { current: boolean },
  detached: { current: boolean },
  educationHistoryUrlAtNext: { current: string | null }
) {
  const session = { on: () => {}, off: () => {} };
  const childFrame = makeAcceptanceChildFrame(
    childUrls,
    state,
    deepLocatorFrame,
    revealed,
    detached
  );
  const fakeDeepLocator = makeFakeDeepLocator(deepLocatorFrame);
  const requiredFieldsFilled = () =>
    state.filledWith.has(`deeplocator=${HOP_SELECTOR} >> nth=${indexes.companyName}`) &&
    state.filledWith.has(`deeplocator=${HOP_SELECTOR} >> nth=${indexes.jobTitle}`) &&
    state.filledWith.has(`deeplocator=${HOP_SELECTOR} >> nth=${indexes.description}`) &&
    state.filledWith.has(`deeplocator=${HOP_SELECTOR} >> nth=${indexes.startDate}`) &&
    state.filledWith.has(`deeplocator=${HOP_SELECTOR} >> nth=${indexes.current}`);

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
            if (index === indexes.reveal) {
              revealed.current = true;
            }
            if (index === indexes.add) {
              if (state.entryFormOpen) {
                state.entryFormReopenedOrClosedEarly = true;
                state.entryFormOpen = false;
              } else {
                state.entryFormOpen = true;
                childUrls.current = ENTRY_OPEN_URL;
              }
            }
            if (index === indexes.current) {
              state.filledWith.set(`deeplocator=${selector} >> nth=${index}`, "true");
              childUrls.current = ENTRY_CURRENT_TOGGLED_URL;
            }
            if (index === indexes.done) {
              if (state.entryFormOpen && requiredFieldsFilled()) {
                state.entryComplete = true;
                state.requiresAttention = false;
                state.entryFormOpen = false;
                childUrls.current = ENTRY_SAVED_URL;
              } else {
                state.requiresAttention = true;
              }
            }
            if (index === indexes.nextToEducation) {
              if (state.entryComplete && !state.requiresAttention) {
                childUrls.current = EDUCATION_HISTORY_URL;
                educationHistoryUrlAtNext.current = childUrls.current;
              }
            }
            if (index === indexes.submit) {
              state.submitted = true;
              childUrls.current = GQ_URL;
              detached.current = true;
              topUrl.current = TOP_THANK_YOU_URL;
            }
          },
          fill: async (value: string) => {
            await nthDelegate.fill(value);
            state.filledWith.set(`deeplocator=${selector} >> nth=${index}`, value);
          },
          selectOption: async (values: string | string[]) => {
            const value = Array.isArray(values) ? (values[0] ?? "") : values;
            state.filledWith.set(`deeplocator=${selector} >> nth=${index}`, value);
            return nthDelegate.selectOption(values);
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
          ? { matched: true, src: `${CHILD_ORIGIN}/application/abc-123` }
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
 * Fake `Stagehand`: `act()` always phantom-fails (forcing every step through
 * the deepLocator cascade — the field condition this whole suite family
 * exists to model), and frame-scoped `observe()` stays blind after each
 * instruction's own one-shot reachability probe, matching
 * `oopif-dense-form-acceptance.test.ts`'s `makeDenseStagehand`.
 */
function makeAcceptanceStagehand() {
  const hopPrefix = `${IFRAME_SELECTOR} >> `;
  const probedInstructions = new Set<string>();
  return {
    act: async (input: unknown) => ({
      success: false,
      message: "no actionable candidate",
      actionDescription: typeof input === "string" ? input : REVEAL_STEP,
      actions: [],
    }),
    observe: async (instruction?: unknown, options?: { selector?: string }) => {
      const isFrameScoped = options?.selector?.startsWith(hopPrefix) ?? false;
      if (!isFrameScoped) return [];
      if (typeof instruction === "string" && !probedInstructions.has(instruction)) {
        probedInstructions.add(instruction);
        return [{ selector: "xpath=//probe-presence", description: "probe-presence" }];
      }
      return [];
    },
  } as unknown as import("@browserbasehq/stagehand").Stagehand;
}

const ACCEPTANCE_STEPS: HealingFlowStep[] = [
  { instruction: REVEAL_STEP, optional: false, upload: false, submitStep: false },
  { instruction: ADD_WH_STEP, optional: false, upload: false, submitStep: false },
  { instruction: COMPANY_NAME_STEP, optional: false, upload: false, submitStep: false },
  { instruction: JOB_TITLE_STEP, optional: false, upload: false, submitStep: false },
  { instruction: DESCRIPTION_STEP, optional: false, upload: false, submitStep: false },
  { instruction: START_DATE_STEP, optional: false, upload: false, submitStep: false },
  { instruction: CURRENT_STEP, optional: false, upload: false, submitStep: false },
  { instruction: DONE_STEP, optional: false, upload: false, submitStep: false },
  { instruction: NEXT_TO_EDUCATION_STEP, optional: false, upload: false, submitStep: false },
  { instruction: SCREENING_STEP, optional: false, upload: false, submitStep: false },
  { instruction: SELF_ID_STEP, optional: false, upload: false, submitStep: false },
  { instruction: SUBMIT_STEP, optional: false, upload: false, submitStep: true },
];

describe("flow-runner replan-preserve-remaining-steps acceptance regression (uchealth-19/-20, offline fixture, no network)", () => {
  it("credits the +789B reveal click as verified (no replan), runs the authored Work-History entry-fill chain exactly once against the open form, completes the entry without Requires Attention, advances to Education History, and reaches a verified submit", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const state: AcceptanceSequenceState = {
      filledWith: new Map(),
      entryFormOpen: false,
      entryFormReopenedOrClosedEarly: false,
      entryComplete: false,
      requiresAttention: false,
      submitted: false,
    };
    const revealed = { current: false };
    const detached = { current: false };
    const educationHistoryUrlAtNext: { current: string | null } = { current: null };
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    const order = buildDenseHopOrder();
    const hop = registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, order);

    const indexes = {
      reveal: findElementIndex(order, REVEAL_ELEMENT_TEXT),
      add: findElementIndex(order, "Add New Work History"),
      companyName: findElementIndex(order, "Company Name"),
      jobTitle: findElementIndex(order, "Job Title"),
      description: findElementIndex(order, "Description"),
      startDate: findElementIndex(order, "Start Date"),
      current: findElementIndex(order, "Current"),
      done: findElementIndex(order, "Done"),
      nextToEducation: findElementIndex(order, "Next"),
      screening: findElementIndex(order, SCREENING_QUESTION_TEXT),
      selfId: findElementIndex(order, SELF_ID_TEXT),
      submit: findElementIndex(order, "Submit"),
    };
    for (const [name, index] of Object.entries(indexes)) {
      expect(index, `${name} index resolved`).toBeGreaterThanOrEqual(0);
    }

    const stagehand = makeAcceptanceStagehand();
    const page = makeAcceptanceTopPage(
      topUrl,
      childUrls,
      deepLocatorFrame,
      state,
      indexes,
      revealed,
      detached,
      educationHistoryUrlAtNext
    );

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: ACCEPTANCE_STEPS,
      logger: SILENT_LOGGER,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: IFRAME_SELECTOR,
      submittedStateSelectors: [SUBMITTED_STATE_SELECTOR],
    });

    // (1) The reveal step (+789B DOM delta, zero network) was credited as a
    // verified click outcome — the run reached every subsequent step, which
    // is only possible if no replan discarded the authored remaining steps.
    expect(revealed.current).toBe(true);
    expect(result.lastStepIndex).toBe(ACCEPTANCE_STEPS.length - 1);

    // (2) Every authored Work-History entry-fill step ran EXACTLY ONCE, in
    // order, against the form it opened: one Add click (never a duplicate/
    // reopen), and each field filled/selected precisely once.
    expect(hop.elements[indexes.add]?.clicks).toBeGreaterThanOrEqual(1);
    expect(state.entryFormReopenedOrClosedEarly).toBe(false);
    expect(hop.elements[indexes.companyName]?.filledWith).toBe("General Hospital");
    expect(hop.elements[indexes.jobTitle]?.filledWith).toBe("Registered Nurse");
    expect(hop.elements[indexes.description]?.filledWith).toBe("Provided direct patient care");
    expect(state.filledWith.get(`deeplocator=${HOP_SELECTOR} >> nth=${indexes.startDate}`)).toBe(
      "2020"
    );
    expect(hop.elements[indexes.done]?.clicks).toBeGreaterThanOrEqual(1);

    // (3) The completed entry was NOT flagged Requires Attention.
    expect(state.entryComplete).toBe(true);
    expect(state.requiresAttention).toBe(false);

    // (4) Next advanced past Work History to Education History (not stuck,
    // not bounced back by an incomplete entry) — captured via the child
    // frame's URL at the moment Next was clicked, before the later
    // submit click's own navigation overwrites `childUrls.current`.
    expect(hop.elements[indexes.nextToEducation]?.clicks).toBeGreaterThanOrEqual(1);
    expect(educationHistoryUrlAtNext.current).toBe(EDUCATION_HISTORY_URL);

    // (5) The simulated remaining flow (screening, self-ID, submit) reached
    // the final submit step and a submit-verification signal — matching the
    // report's real post-submit surface (an intermediate `.../gq` child URL,
    // then the TOP window on the site's own thank-you page) — was asserted
    // true.
    expect(state.filledWith.get(`deeplocator=${HOP_SELECTOR} >> nth=${indexes.screening}`)).toBe(
      "Yes"
    );
    expect(state.submitted).toBe(true);
    expect(result.submitStepSkipped).toBe(false);
    expect(result.submitVerified).toBe(true);
    expect(topUrl.current).toBe(TOP_THANK_YOU_URL);

    // No candidate outside the authored ordered chain was ever clicked.
    for (const [index, element] of hop.elements.entries()) {
      if (Object.values(indexes).includes(index)) continue;
      expect(element.clicks).toBe(0);
    }
  });
});
