import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * End-to-end acceptance regression for the mixed-semantics flow the
 * `flowHasSubmitSemantics` fix targets: an EARLIER step carries
 * `submitStep: true` and resolves via a real URL-changing submission, while
 * the flow's FINAL step is an ordinary same-page ARIA/class-state toggle
 * (`submitStep: false`). Before the fix, `flowHasSubmitSemantics` returned
 * `true` flow-wide whenever ANY step declared `submitStep`, so the final
 * step's own `submitStep: false` was overridden and it was routed through
 * the submit-only verification gate — deep-submit-locator, with
 * `structured-click`/`observe-act-exclude` skipped as "submit-shaped step" —
 * even though the step is a plain tab click with no submit semantics of its
 * own. The fix makes the explicit flag authoritative for the step that
 * carries it: `flowHasSubmitSemantics` now trusts the FINAL step's own flag
 * over an earlier, unrelated step's flag, so this step keeps
 * `captureSelectionState=true` and verifies via the element-scoped
 * ARIA/class fingerprint diff in `verifyDomEffect`'s click branch — on both a
 * DOM-growing click and a DOM-shrinking click — instead of ever escalating to
 * `deep-submit-locator` or exhausting `MAX_STEP_ATTEMPTS` for a structurally
 * unresolvable reason.
 *
 * **Structure:** Modeled on
 * `flow-runner.readonly-final-step-click-acceptance.test.ts`'s single
 * mutable `AcceptanceSequenceState` threaded through fake `Stagehand`/`Page`
 * objects, asserted against captured logger lines after `runHealingFlow`
 * resolves — plus the SELECTION_STATE_MAP_EXPR / element-fingerprint
 * `evaluate()` shapes `flow-runner.element-state-click-verify.test.ts`
 * exercises directly against `verifyDomEffect`, wired here through the real
 * cascade instead of called in isolation.
 */

const BASE_URL = "https://www.listings-fixture.example.com/listings";
const SUBMIT_STEP = "Click the 'Save Preferences' button to submit the search profile";
const TAB_STEP = "Click the '2-Bed' listing type tab to view that type's per-unit price";

const SUBMIT_SELECTOR = "xpath=//button[@data-role='save-preferences']";
const TAB_XPATH = "/html[1]/body[1]/div[1]/nav[1]/button[2]";
const TAB_SELECTOR = `xpath=${TAB_XPATH}`;

interface CapturedLogs {
  info: string[];
  warn: string[];
}

function makeCapturingLogger(): { logger: Logger; captured: CapturedLogs } {
  const captured: CapturedLogs = { info: [], warn: [] };
  const logger = {
    info: (msg: string) => {
      captured.info.push(msg);
    },
    warn: (msg: string) => {
      captured.warn.push(msg);
    },
    error: () => {},
    debug: () => {},
  } as unknown as Logger;
  return { logger, captured };
}

interface Fingerprint {
  kind: string;
  cls: string;
  ariaPressed: string;
  ariaChecked: string;
  ariaSelected: string;
  dataState: string;
  dataSelected: string;
  dataChecked: string;
  checked: string;
  value: string;
}

const fp = (ariaSelected: string): Fingerprint => ({
  kind: "",
  cls: "",
  ariaPressed: "",
  ariaChecked: "",
  ariaSelected,
  dataState: "",
  dataSelected: "",
  dataChecked: "",
  checked: "",
  value: "",
});

/** In-memory model of the mixed-semantics flow's observable state. */
interface AcceptanceSequenceState {
  url: string;
  bodyHtmlLength: number;
  /** The tab's own `aria-selected`, flipped by whichever attempt's click lands. */
  tabSelected: boolean;
  submitClicked: boolean;
  tabClicked: boolean;
}

/**
 * Matches `flow-runner.readonly-final-step-click-acceptance.test.ts`'s fake
 * page's `evaluate()` surface, plus the two additional expression shapes the
 * element-scoped selection read-back needs: the `SELECTION_STATE_MAP_EXPR`
 * baseline capture (uniquely identified by `isCommittedValueControl`, which
 * only that expression contains) and the per-element fingerprint read
 * (`elementSelectionFingerprintExpr`, uniquely identified by
 * `getAttribute("kind")`).
 */
function makeMixedFlowPage(state: AcceptanceSequenceState): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("isCommittedValueControl")) {
        // SELECTION_STATE_MAP_EXPR: pre-action per-element baseline, keyed by
        // the tab's own absolute xpath — only populated when
        // captureSelectionState is true, i.e. only once the fix stops the
        // earlier submit step's flag from overriding this step's own.
        return { [TAB_XPATH]: fp(state.tabSelected ? "true" : "false") };
      }
      if (src.includes('getAttribute("kind")')) {
        // elementSelectionFingerprintExpr: post-click read of the SAME
        // element the pre-baseline captured.
        return fp(state.tabSelected ? "true" : "false");
      }
      if (src.includes("aria-disabled")) return false;
      if (src.includes("el.type || null")) return null;
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return { html: state.bodyHtmlLength, text: "current step 2 of 2" };
      }
      if (src.includes("isInvalid(el)")) return 0;
      if (src.includes("isCheckable")) return { resolved: true, isCheckable: false };
      return null;
    },
    url: () => state.url,
    title: async () => "Listings | Listings Fixture",
    locator: () => ({
      first: () => ({
        click: async () => {
          throw new Error("locator resolved to 0 elements");
        },
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async () => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

/**
 * Fake `Stagehand`: `act(SUBMIT_STEP)` reports a real URL-changing
 * submission on attempt 1 (the earlier step's genuine `submitStep: true`
 * semantics). `act(TAB_STEP)` reports success on attempt 1 too, and its
 * click mutates `state.tabSelected` plus the body-HTML length by
 * `bodyDeltaOnTabClick` (positive to model a DOM-growing click, negative to
 * model a DOM-shrinking one) — the report's exact evidence shape: a real
 * effect on the clicked element's own ARIA state, no network/url change.
 */
function makeMixedFlowStagehand(
  state: AcceptanceSequenceState,
  bodyDeltaOnTabClick: number
): Stagehand {
  return {
    act: vi.fn().mockImplementation(async (input: unknown) => {
      if (typeof input === "string" && input === SUBMIT_STEP) {
        state.submitClicked = true;
        state.url = `${BASE_URL}#preferences-saved`;
        return {
          success: true,
          message: "clicked",
          actionDescription: "Clicked 'Save Preferences'",
          actions: [
            { selector: SUBMIT_SELECTOR, description: "Save Preferences", method: "click" },
          ],
        };
      }
      if (typeof input === "string" && input === TAB_STEP) {
        state.tabClicked = true;
        state.tabSelected = !state.tabSelected;
        state.bodyHtmlLength += bodyDeltaOnTabClick;
        return {
          success: true,
          message: "clicked",
          actionDescription: "Clicked '2-Bed' tab",
          actions: [{ selector: TAB_SELECTOR, description: "2-Bed tab", method: "click" }],
        };
      }
      return {
        success: false,
        message: "no actionable candidate",
        actionDescription: "",
        actions: [],
      };
    }),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string" && (instruction === SUBMIT_STEP || instruction === TAB_STEP)
          ? [{ selector: TAB_SELECTOR, description: "2-Bed tab", method: "click" }]
          : []
      ),
  } as unknown as Stagehand;
}

const MIXED_STEPS: HealingFlowStep[] = [
  { instruction: SUBMIT_STEP, optional: false, upload: false, submitStep: true },
  { instruction: TAB_STEP, optional: false, upload: false, submitStep: false },
];

describe("flow-runner mixed submit-semantics acceptance regression (earlier submitStep + final same-page toggle)", () => {
  it("verifies the final toggle step via the element-scoped ARIA diff on a DOM-GROWING click, never escalating to deep-submit-locator", async () => {
    const state: AcceptanceSequenceState = {
      url: BASE_URL,
      bodyHtmlLength: 42_000,
      tabSelected: false,
      submitClicked: false,
      tabClicked: false,
    };
    const stagehand = makeMixedFlowStagehand(state, 6_000);
    const page = makeMixedFlowPage(state);
    const { logger, captured } = makeCapturingLogger();

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: MIXED_STEPS,
      logger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
    });

    expect(result).toMatchObject({ lastStepIndex: 1 });
    expect(state.submitClicked).toBe(true);
    expect(state.tabClicked).toBe(true);
    expect(state.tabSelected).toBe(true);
    expect(state.bodyHtmlLength).toBe(48_000);

    const allLogs = [...captured.info, ...captured.warn];
    expect(allLogs.some((l) => l.includes("no observable effect"))).toBe(false);
    expect(allLogs.some((l) => l.toLowerCase().includes("phantom"))).toBe(false);
    expect(
      allLogs.some((l) => l.includes("escalating attempt") && l.includes("deep-submit-locator"))
    ).toBe(false);
    expect(allLogs.some((l) => l.includes("deep-submit-locator"))).toBe(false);
  });

  it("verifies the final toggle step via the element-scoped ARIA diff on a DOM-SHRINKING click, never escalating to deep-submit-locator", async () => {
    const state: AcceptanceSequenceState = {
      url: BASE_URL,
      bodyHtmlLength: 42_000,
      tabSelected: false,
      submitClicked: false,
      tabClicked: false,
    };
    const stagehand = makeMixedFlowStagehand(state, -6_000);
    const page = makeMixedFlowPage(state);
    const { logger, captured } = makeCapturingLogger();

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: MIXED_STEPS,
      logger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
    });

    expect(result).toMatchObject({ lastStepIndex: 1 });
    expect(state.submitClicked).toBe(true);
    expect(state.tabClicked).toBe(true);
    expect(state.tabSelected).toBe(true);
    expect(state.bodyHtmlLength).toBe(36_000);

    const allLogs = [...captured.info, ...captured.warn];
    expect(allLogs.some((l) => l.includes("no observable effect"))).toBe(false);
    expect(allLogs.some((l) => l.toLowerCase().includes("phantom"))).toBe(false);
    expect(
      allLogs.some((l) => l.includes("escalating attempt") && l.includes("deep-submit-locator"))
    ).toBe(false);
    expect(allLogs.some((l) => l.includes("deep-submit-locator"))).toBe(false);
  });
});
