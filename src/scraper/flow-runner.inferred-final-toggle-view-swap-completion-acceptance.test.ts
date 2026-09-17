import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Acceptance regression for the report's exact reproduction: a same-page
 * category/tab toggle click that is the flow's ONLY/final step, on a flow
 * that declares `submitEndpointPattern` (so `flowHasSubmitSemantics` is
 * true) but has NO step anywhere flagged `submitStep: true`, AND whose
 * clicked element carries no ARIA/data-state/class-token marker at all —
 * so `verifyDomEffect`'s element-scoped fingerprint diff can never register
 * a change (`domVerified` stays false for every attempt). Before this fix,
 * `isClickViewSwapVerified` additionally vetoed its own page-wide
 * byte-growth credit whenever `isFinalStep && flowHasSubmitSemantics`, even
 * though this step never receives a real network/URL transition by design —
 * leaving NO signal that could ever satisfy `verified`, burning every
 * cascade attempt (the reported unbounded-churn defect). This must pass on
 * attempt 1 via the page-wide DOM-growth credit alone.
 */

const BASE_URL = "https://www.rental-fixture.example.com/listings/unit-42";
const TAB_STEP = "Click the 'Studio' unit-type tab to view that unit type's price";

const TAB_CANDIDATES = [
  { selector: "xpath=//button[@data-tab='studio']", description: "Studio tab", method: "click" },
];
// biome-ignore lint/style/noNonNullAssertion: fixed-length literal array above
const SELECTED_CANDIDATE = TAB_CANDIDATES[0]!;
const TAB_XPATH_BODY = "//button[@data-tab='studio']";

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

/**
 * `tabClicked` flips exactly once, on the real click, and only grows the
 * page's overall body length (a sibling price panel reveals) — the clicked
 * element's OWN fingerprint (ariaSelected/cls/dataState/etc.) never changes,
 * modeling a tab whose selection commit carries no qualifying marker at all.
 */
interface AcceptanceSequenceState {
  tabClicked: boolean;
}

const UNMARKED_FINGERPRINT: Record<string, unknown> = {
  kind: "",
  cls: "tab",
  ariaPressed: "",
  ariaChecked: "",
  ariaSelected: "",
  dataState: "",
  dataSelected: "",
  dataChecked: "",
  checked: "",
  value: "",
};

function makeFlowPage(state: AcceptanceSequenceState): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return {
          // Only the page-wide body length grows past VIEW_SWAP_MIN_BYTES
          // once the click lands — the element's own fingerprint never
          // changes, so this byte-growth credit is the ONLY signal.
          html: state.tabClicked ? 42_000 : 10_000,
          text: "unit price panel",
          values: "",
        };
      }
      if (src.includes("isInvalid(el)")) return 0;
      if (src.includes("isCheckable")) return { resolved: true, isCheckable: false };
      // SELECTION_STATE_MAP_EXPR: pre-click element-scoped baseline map.
      if (src.includes("isCommittedValueControl")) {
        return { [TAB_XPATH_BODY]: UNMARKED_FINGERPRINT };
      }
      // elementSelectionFingerprintExpr: post-click read-back — identical to
      // the baseline, so verifyDomEffect's diff registers no change and
      // domVerified stays false regardless of attempt count.
      if (src.includes('el.getAttribute("kind")') && src.includes(JSON.stringify(TAB_XPATH_BODY))) {
        return UNMARKED_FINGERPRINT;
      }
      if (src.includes("el.type") && src.includes(JSON.stringify(TAB_XPATH_BODY))) {
        return null;
      }
      return null;
    },
    url: () => BASE_URL,
    title: async () => "Unit 42 | Rental Fixture",
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
  } as unknown as Page;
}

function makeFlowStagehand(state: AcceptanceSequenceState): Stagehand {
  return {
    act: vi.fn().mockImplementation(async (input: unknown) => {
      if (typeof input === "string" && input === TAB_STEP) {
        state.tabClicked = true;
        return {
          success: true,
          message: "clicked",
          actionDescription: `Clicked "${SELECTED_CANDIDATE.description}"`,
          actions: [SELECTED_CANDIDATE],
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
        typeof instruction === "string" && instruction === TAB_STEP ? TAB_CANDIDATES : []
      ),
  } as unknown as Stagehand;
}

const TOGGLE_STEPS: HealingFlowStep[] = [
  { instruction: TAB_STEP, optional: false, upload: false, submitStep: false },
];

describe("flow-runner acceptance — inferred final toggle step completes via page-wide view-swap credit", () => {
  it("completes on attempt 1 via DOM-growth credit even though the flow declares submitEndpointPattern and no step is flagged submitStep", async () => {
    const state: AcceptanceSequenceState = { tabClicked: false };
    const stagehand = makeFlowStagehand(state);
    const page = makeFlowPage(state);
    const { logger, captured } = makeCapturingLogger();

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: TOGGLE_STEPS,
      logger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      // Flow-wide submit signal — but no step here is flagged
      // `submitStep: true`, since recon never reached the real submit step.
      submitEndpointPattern: "/bookings/confirm$",
      requireSubmitEndpointMatch: false,
    });

    expect(result).toMatchObject({
      submitVerified: false,
      submitStepSkipped: false,
      lastStepIndex: 0,
    });

    expect(stagehand.act).toHaveBeenCalledTimes(1);
    expect(state.tabClicked).toBe(true);

    expect(
      captured.warn.some((l) => l.includes("escalating attempt 2 to deep-submit-locator"))
    ).toBe(false);
    expect(captured.info.some((l) => l.includes("deep-submit-locator"))).toBe(false);
    expect(captured.warn.some((l) => l.includes("deep-submit-locator"))).toBe(false);
  });
});
