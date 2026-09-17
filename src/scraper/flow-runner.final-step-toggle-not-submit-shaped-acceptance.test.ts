import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Acceptance regression for the middle case neither
 * `flow-runner.readonly-final-step-click-acceptance.test.ts` (no submit
 * semantics anywhere) nor
 * `flow-runner.submit-flow-phantom-click-regression.test.ts` (final step
 * genuinely IS the submit) cover: a flow that DOES declare submit semantics
 * flow-wide (a `submitEndpointPattern` matching a real booking-style flow's
 * eventual submit endpoint), but whose recon slice never reached that step —
 * the probed FINAL step is an ordinary same-page category tab toggle, not a
 * submit action.
 *
 * `flowHasSubmitSemantics` only trusts the final step's own `submitStep`
 * flag over inference when SOME step is flagged `submitStep: true`. When no
 * step carries that flag at all (the self-heal-appended-final-step /
 * recon-never-reached-the-real-submit-step shape modeled here), it falls
 * back to `submitEndpointPattern !== null`, unconditionally — so the final
 * step here is still misclassified as submit-shaped purely because a flow-
 * level submit pattern exists somewhere in the flow's config, even though
 * this step plainly isn't it. This must fail today (proving the gap) and
 * pass once submit-shape derivation stops inferring from
 * `submitEndpointPattern` when the probed final step is an ordinary toggle.
 */

const BASE_URL = "https://www.rental-fixture.example.com/listings/unit-42";
const TAB_STEP = "Click the 'Studio' unit-type tab to view that unit type's price";

const TAB_CANDIDATES = [
  { selector: "xpath=//button[@data-tab='studio']", description: "Studio tab", method: "click" },
  { selector: "xpath=//button[@data-tab='one-bed']", description: "1-Bed tab", method: "click" },
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
 * In-memory model of the tab-detail page's observable state. `tabState`
 * flips exactly once, on the real click, and is what the DOM-snapshot
 * expression reports back as the selection-state signature — never the
 * url/network signal, so the credit under test must come from the
 * per-attempt selection-state baseline rather than a page navigation.
 */
interface AcceptanceSequenceState {
  tabState: "studio-unselected" | "studio-selected";
  unitTabClicked: boolean;
}

/**
 * The element-scoped `ElementSelectionFingerprint` `verifyDomEffect`'s click
 * branch diffs (see `selectionFingerprintObjSrc` / `SELECTION_STATE_MAP_EXPR`
 * in flow-runner.ts): `ariaSelected` flips false->true the instant the click
 * genuinely lands, mirroring a real "tab" role's `aria-selected` commit —
 * live off `state.tabState` so the SAME live read serves both the pre-click
 * baseline (`SELECTION_STATE_MAP_EXPR`) and the post-click element read-back
 * (`elementSelectionFingerprintExpr`) without the fixture tracking pre/post
 * separately.
 */
function tabFingerprint(tabState: AcceptanceSequenceState["tabState"]): Record<string, unknown> {
  return {
    kind: "",
    cls: tabState === "studio-selected" ? "tab active" : "tab",
    ariaPressed: "",
    ariaChecked: "",
    ariaSelected: tabState === "studio-selected" ? "true" : "false",
    dataState: "",
    dataSelected: "",
    dataChecked: "",
    checked: "",
    value: "",
  };
}

function makeFlowPage(state: AcceptanceSequenceState): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return {
          html: 42_000,
          text: "unit price panel",
          values: "",
          state: state.tabState,
        };
      }
      if (src.includes("isInvalid(el)")) return 0;
      if (src.includes("isCheckable")) return { resolved: true, isCheckable: false };
      // SELECTION_STATE_MAP_EXPR: the pre-click element-scoped baseline map,
      // built ONLY when shouldCaptureSelectionState allows it for this step.
      if (src.includes("isCommittedValueControl")) {
        return { [TAB_XPATH_BODY]: tabFingerprint(state.tabState) };
      }
      // elementSelectionFingerprintExpr: the post-click read-back of the
      // resolved element's own fingerprint. Checked BEFORE the bare `el.type`
      // probe below since this expression's `checked` field itself derives
      // from `el.type === "checkbox"`, so it also contains the substring
      // "el.type" and would otherwise be misrouted to the probe branch.
      if (src.includes('el.getAttribute("kind")') && src.includes(JSON.stringify(TAB_XPATH_BODY))) {
        return tabFingerprint(state.tabState);
      }
      // verifyDomEffect's click branch: the standalone `el.type` radio/
      // checkbox-exclusion probe — a plain <button> has no `.type`.
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

/**
 * Fake `Stagehand`: `observe(step, ...)` reports the probe's tab candidates.
 * `act(step)` on attempt 1 (act-string) genuinely toggles the tab's
 * selection state — no url/network change at all — the exact shape the
 * credit must recognize via the element-state signal.
 */
function makeFlowStagehand(state: AcceptanceSequenceState): Stagehand {
  return {
    act: vi.fn().mockImplementation(async (input: unknown) => {
      if (typeof input === "string" && input === TAB_STEP) {
        state.unitTabClicked = true;
        state.tabState = "studio-selected";
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

describe("flow-runner acceptance — flow-level submitEndpointPattern must not submit-shape a non-submit final toggle step", () => {
  it("falls through to the element-state credit instead of routing to deep-submit-locator, even though the flow declares submitEndpointPattern elsewhere", async () => {
    const state: AcceptanceSequenceState = {
      tabState: "studio-unselected",
      unitTabClicked: false,
    };
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
      // The flow-wide submit signal a real booking-style flow declares —
      // but no step here is flagged `submitStep: true`, because recon never
      // reached the real Reserve/Pay step. The only step present is an
      // ordinary same-page tab toggle.
      submitEndpointPattern: "/bookings/confirm$",
      requireSubmitEndpointMatch: false,
    });

    expect(result).toMatchObject({
      submitVerified: false,
      submitStepSkipped: false,
      lastStepIndex: 0,
    });

    expect(captured.info.some((l) => l.includes("probe found 2 candidate(s)"))).toBe(true);

    // The step must complete via the element-state-driven credit (the
    // selection-state signature flipped with no network/url change), never
    // by escalating to deep-submit-locator.
    expect(
      captured.warn.some((l) => l.includes("escalating attempt 2 to deep-submit-locator"))
    ).toBe(false);
    expect(captured.info.some((l) => l.includes("deep-submit-locator"))).toBe(false);
    expect(captured.warn.some((l) => l.includes("deep-submit-locator"))).toBe(false);

    const submitShapedSkips = [...captured.info, ...captured.warn].filter(
      (l) => l.includes("skipped") && l.includes("submit-shaped step")
    );
    expect(submitShapedSkips).toEqual([]);

    expect(state.unitTabClicked).toBe(true);
  });
});
