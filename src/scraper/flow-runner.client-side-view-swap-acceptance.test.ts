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
 * Offline acceptance regression for the top-window site Manual Application
 * click-view-swap scenario (run-8): a click that reveals a form via pure
 * client-side DOM manipulation (measured: +49518B body HTML, zero network
 * captures) must be credited as a successful step outcome, not scored as
 * "no observable effect" and excluded from future attempts.
 *
 * **What this pins:** The `isClickViewSwapVerified` gate (line 1084-1106,
 * flow-runner.ts) correctly credits a click producing ≥5KB DOM growth with
 * zero network when the step is NOT a submit/final step and NOT an
 * advance-pattern step. Without this gate, the Manual Application click
 * (which swaps the method-chooser for the basic-info form, no network)
 * would be scored as failure → the correct candidate excluded on attempt 4
 * → the cascade picks "Close" instead → cancel-dialog loop → cycle-detection
 * abort at step 3/31 (the exact run-8 trap).
 *
 * **Scope:** Manual Application reveal + form-appears transition only
 * (matching the acceptance test's stated pass condition: "clicking 'Manual
 * Application' ... is credited as success ... the run advances into the
 * in-frame form"). The later verified-submit leg of the acceptance criteria
 * is out of scope — that requires a real submit endpoint shape and is
 * covered by `flow-runner.oopif-dense-form-acceptance.test.ts`.
 *
 * **Structure:** Modeled on `flow-runner.iframe-e2e.test.ts`'s "mid-flow
 * iframe attachment" suite (fake child frame + top page, frame-scoped
 * observe+act) and `flow-runner.oopif-dense-form-acceptance.test.ts`'s
 * harness pattern (dense OOPIF child frame with interactive-candidate-scoped
 * hop). Kept in its own file so a regression of the click-view-swap gate
 * fails with an immediately-diagnosable name.
 */

const TOP_ORIGIN = "https://careers.example.org";
const CHILD_ORIGIN = "https://apply.example.com";
const IFRAME_SELECTOR = "iframe#apply_frame";
const CHILD_SRC = `${CHILD_ORIGIN}/application/abc-123`;
/** The cascade's actual hop (`flow-runner.ts` scopes the observe-act fallback to `INTERACTIVE_CANDIDATE_SELECTOR`, not `"*"`) — must match so the fake's registered elements resolve at the same selector the cascade clicks through. */
const HOP_SELECTOR = `${IFRAME_SELECTOR} >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;

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

/**
 * Accessible names for the fill target living inside the SAME dense hop as
 * "Manual Application" — a real `<input>` has empty `textContent` per the DOM
 * spec, so in the live DOM this name would come from `aria-label`/an
 * associated `<label>`/`placeholder` (`buildAccessibleNameExpr`,
 * `deep-locator-scan.ts`), never from `textContent`. The fake's single `text`
 * field already models the COMPUTED accessible name (see
 * `FakeDeepLocatorElement`'s docstring), so no separate raw-textContent field
 * is needed to keep that distinction real.
 */
const FIRST_NAME_ELEMENT: FakeDeepLocatorElementSpec = { text: "First Name" };

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
 * Reproduces the run-8 "some candidates are decoys named in the negation
 * clause" condition. All rendered (no layout-less duplicates needed here —
 * `flow-runner.oopif-dense-form-acceptance.test.ts` already pins the
 * visibility-filter regression separately).
 */
const DECOYS: FakeDeepLocatorElementSpec[] = [
  { text: "Upload a Resume/CV", visible: true },
  { text: "Use LinkedIn Profile", visible: true },
  { text: "Upload From Dropbox", visible: true },
  { text: "Upload From OneDrive", visible: true },
];

/** Filler-block sizes (structural, empty-text, rendered nodes) that sum to a +48KB-class DOM. With the 4 decoys, the 1 fill target, and the real target, 50+ elements total, large enough to trigger the ≥5KB view-swap threshold. */
const FILLER_BLOCK_SIZES = [12, 12, 12, 10];

/**
 * The First Name fill target, placed in the second filler block (matching
 * the actual form layout) — it is genuinely part of the SAME hop the
 * "Manual Application" click resolves against, not a distinct form the
 * fixture models separately. `undefined` entries keep the total element
 * count aligned with `DECOYS`' 4-entry placement.
 */
const FORM_FIELD_ELEMENTS: ReadonlyArray<FakeDeepLocatorElementSpec | undefined> = [
  undefined,
  FIRST_NAME_ELEMENT,
  undefined,
  undefined,
];

/**
 * Builds the DOM-order array a dense hop over the embedded apply wizard resolves
 * to: filler blocks with the four decoys and the fill target interspersed
 * between them, and — when `includeTarget` — the real "Manual Application"
 * button LAST.
 *
 * `includeTarget` = false models the negative control (no button ever
 * matches the instruction → cascade exhausts).
 *
 * DOM-order-last is deliberate: it is what makes a passing run attributable
 * to the ranked cascade rather than DOM-order luck (same falsifier the
 * candidate-ranking suite already uses).
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

/** Position of the first element whose accessible name is `text` — used to locate the First Name target within `buildDenseHopOrder`'s array without hand-tracking its index through the filler/decoy interleaving. */
function findElementIndex(
  order: ReadonlyArray<string | FakeDeepLocatorElementSpec>,
  text: string
): number {
  return order.findIndex((entry) => typeof entry !== "string" && entry.text === text);
}

/** In-memory model of the field the acceptance sequence fills inside the OOPIF. */
interface ViewSwapSequenceState {
  filledWith: Map<string, string>;
  /** Body HTML size in bytes BEFORE the Manual Application click. */
  initialBodyHtmlSize: number;
  /** Body HTML size in bytes AFTER the Manual Application click (the +48KB-class view swap). */
  postClickBodyHtmlSize: number;
}

/**
 * Child `Frame` fake: `location.href`/`document.readyState`/fill-readback
 * match `flow-runner.iframe-e2e.test.ts`'s `makeAcceptanceChildFrame`.
 * `outerHTML.length` returns `state.initialBodyHtmlSize` before the click and
 * `state.postClickBodyHtmlSize` after — modeling the +48KB DOM growth the
 * click-view-swap gate exists to credit. The `<body>` probe is the exact
 * expression `snapshotPage` evaluates (`flow-runner.ts` line ~1975), so this
 * fixture's ≥5KB delta feeds into the real verification chain.
 */
function makeViewSwapChildFrame(
  childUrls: { current: string },
  state: ViewSwapSequenceState,
  _deepLocatorFrame: FakeDeepLocatorFrame,
  clickHappened: { current: boolean }
) {
  return {
    evaluate: async (expr: unknown) => {
      const src = String(expr);
      if (src === "location.href") return childUrls.current;
      if (src === "document.readyState") return "complete";
      if (src.includes("outerHTML") && src.includes("innerText")) {
        const html = clickHappened.current
          ? state.postClickBodyHtmlSize
          : state.initialBodyHtmlSize;
        return { html, text: "1:apply" };
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

/**
 * Fake two-frame `Page`. `deepLocator(...).nth(index).click()` only
 * navigates the child frame to the basic-info page AND flips `clickHappened`
 * (triggering the +48KB body HTML delta) when `index` is `targetIndex` (the
 * "Manual Application" button's position) — every other index (a decoy or
 * filler) resolves as a no-op click with zero downstream effect. That
 * per-index discrimination is what makes a passing "view-swap verified"
 * signal attributable to clicking the CORRECT element, not just attributable
 * to "some click happened".
 *
 * `targetIndex: null` (the negative control) means no index ever navigates
 * to basic-info or triggers the DOM delta.
 *
 * `deepLocator(...).nth(index).fill(value)` records `value` on the fake
 * delegate's own per-element `filledWith` AND on `state.filledWith`, keyed
 * by the exact `deeplocator=...>>nth=N` selector `resolvedAction.selector`
 * carries — the same key `makeViewSwapChildFrame`'s
 * `locator(selector).first().inputValue()` reads back, so `flow-runner.ts`'s
 * own `verifyDomEffect` (not just this test's assertions) sees the fill and
 * marks the step verified.
 */
function makeViewSwapTopPage(
  topUrl: { current: string },
  childUrls: { current: string },
  deepLocatorFrame: FakeDeepLocatorFrame,
  state: ViewSwapSequenceState,
  targetIndex: number | null,
  clickHappened: { current: boolean }
) {
  const session = { on: () => {}, off: () => {} };
  const childFrame = makeViewSwapChildFrame(childUrls, state, deepLocatorFrame, clickHappened);
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
              clickHappened.current = true;
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
    title: async () => "the top-window site Careers",
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
}

/**
 * Fake `Stagehand`: `act(instruction: string)` (attempt 1, every step)
 * always phantom-fails, forcing every step through attempt 2's
 * observe-act/deepLocator path — that is the actual field condition the
 * bug report names: `observe()` cannot see into the cross-origin OOPIF at
 * all, not selectively for one step.
 *
 * `observe()` is blind (`[]`) for every frame-scoped instruction — the
 * deepLocator cascade under test runs for every step. Top-frame observe
 * returns the usual nav/share/Apply-now controls.
 */
function makeViewSwapStagehand() {
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
      return [];
    },
  } as unknown as import("@browserbasehq/stagehand").Stagehand;
}

const VIEW_SWAP_STEPS: HealingFlowStep[] = [
  { instruction: MANUAL_APPLICATION_STEP, optional: false, upload: false, submitStep: false },
  { instruction: FIRST_NAME_STEP, optional: false, upload: false, submitStep: false },
];

describe("flow-runner client-side view-swap acceptance regression (oopif-8, offline fixture, no network)", () => {
  it("clicks 'Manual Application' (DOM +48KB, zero network) → credited as success → subsequent fill step resolves against the now-rendered form", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const clickHappened = { current: false };
    const state: ViewSwapSequenceState = {
      filledWith: new Map(),
      initialBodyHtmlSize: 1200,
      postClickBodyHtmlSize: 49718,
    };
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    const order = buildDenseHopOrder(true);
    expect(order.length).toBeGreaterThan(50);
    const hop = registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, order);
    const targetIndex = order.length - 1;
    const firstNameIndex = findElementIndex(order, "First Name");

    const stagehand = makeViewSwapStagehand();
    const page = makeViewSwapTopPage(
      topUrl,
      childUrls,
      deepLocatorFrame,
      state,
      targetIndex,
      clickHappened
    );

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: VIEW_SWAP_STEPS,
      logger: SILENT_LOGGER,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      frameSelector: IFRAME_SELECTOR,
    });

    // Both steps completed — the click was NOT scored as "no observable
    // effect" and excluded, so the cascade did NOT fall through to "Close"
    // or exhaust its attempts.
    expect(result.lastStepIndex).toBe(VIEW_SWAP_STEPS.length - 1);

    // Only the real, last-in-DOM-order button was clicked — not a decoy, not
    // a filler node, and not the First Name field (that was filled, not clicked).
    expect(hop.elements[targetIndex]?.clicks).toBeGreaterThan(0);
    for (const [index, element] of hop.elements.entries()) {
      if (index === targetIndex) continue;
      expect(element.clicks).toBe(0);
    }

    // The click triggered the +48KB DOM delta (the view swap), proving
    // isClickViewSwapVerified credited it despite zero network.
    expect(clickHappened.current).toBe(true);
    expect(childUrls.current).toBe(`${CHILD_ORIGIN}/application/abc-123/basic-info`);

    // The subsequent fill step resolved against the now-rendered form — the
    // First Name field was filled via the deepLocator fill actuation path
    // (`fillDeepLocatorCandidate`), not Stagehand's `act()` — the fake
    // delegate's own `filledWith` recording proves the actuation, and
    // `result.lastStepIndex` above already proves `verifyDomEffect`'s DOM
    // re-read accepted it as verified.
    expect(hop.elements[firstNameIndex]?.filledWith).toBe("Jane");
  });

  it("negative control: with 'Manual Application' absent from the same hop, the click step exhausts the cascade and the run never reaches fill", async () => {
    const topUrl = { current: `${TOP_ORIGIN}/jobs/123/apply` };
    const childUrls = { current: CHILD_SRC };
    const clickHappened = { current: false };
    const state: ViewSwapSequenceState = {
      filledWith: new Map(),
      initialBodyHtmlSize: 1200,
      postClickBodyHtmlSize: 49718,
    };
    const deepLocatorFrame: FakeDeepLocatorFrame = new Map();
    const order = buildDenseHopOrder(false);
    expect(order.length).toBeGreaterThan(50);
    registerDeepLocatorHopElements(deepLocatorFrame, HOP_SELECTOR, order);

    const stagehand = makeViewSwapStagehand();
    // No element ever matches "Manual Application", so no index should ever
    // be treated as the target — targetIndex: null makes every click a no-op.
    const page = makeViewSwapTopPage(
      topUrl,
      childUrls,
      deepLocatorFrame,
      state,
      null,
      clickHappened
    );

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: VIEW_SWAP_STEPS,
        logger: SILENT_LOGGER,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
        frameSelector: IFRAME_SELECTOR,
      })
    ).rejects.toThrow(/cascade|attempts|verification|candidates/i);

    // Attributable to the click step specifically: no fill ever ran, no DOM
    // delta ever happened, and the child frame never left its initial URL.
    expect(state.filledWith.size).toBe(0);
    expect(clickHappened.current).toBe(false);
    expect(childUrls.current).toBe(CHILD_SRC);
  });
});
