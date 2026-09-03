import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression for bugfix-004: a design-system combobox opener (ARIA
 * `role=combobox`) paired with a hidden native `<select>` the library keeps
 * in sync behind it (Base Web `bb-customSelect` and similar vendors). The
 * opener's own text/`aria-activedescendant` readback stays ambiguous right
 * after the option click (this widget renders no committed-value label node
 * and never clears its `aria-invalid` marker until final submit), so
 * `commitPromptOption`'s pre-existing readback alone reports `ok:false` —
 * the paired hidden `<select>`'s CURRENT value corroborates the commit
 * instead.
 */

const QUESTION_LABEL = "How Did You Hear About Us?";
const OPTION = "Job Boards";
const STEP = `for '${QUESTION_LABEL}' select '${OPTION}'`;

const OPTIONS = [
  { label: OPTION, value: "job-boards" },
  { label: "Referral", value: "referral" },
];

// The paired hidden <select>'s OWN option text/value deliberately does NOT
// exactly equal `OPTION` — trySelectPrimitive's deterministic fast-path
// matches on an EXACT option-text/value match, and (with `anthropic: null`
// in these tests) has no LLM fallback, so a select with only a near-match
// falls through cleanly and leaves this widget for tryPromptSelectorPrimitive,
// same as it will once the sibling opener-paired-hidden-select guard (a
// separate fix) lands. The corroboration branch under test only needs a
// SUBSTRING match, so this still exercises it.
const HIDDEN_SELECT_OPTION_TEXT = `${OPTION} — via referral program`;
const HIDDEN_SELECT_OPTION_VALUE = "job-boards-referral";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const WIDGET_HTML = `
<div data-automation-id="applyFlowMyInfoPage">
  <div role="group" aria-labelledby="source-section">
    <span id="source-section">${QUESTION_LABEL}</span>
    <div data-automation-id="formField-source">
      <div id="src-widget" role="combobox" aria-haspopup="listbox" aria-controls="src-popup"
           aria-invalid="true" tabindex="0"><span></span></div>
      <select id="hidden-sel" name="source" class="form-control dropdown-hide">
        <option value="">Select</option>
        <option value="${HIDDEN_SELECT_OPTION_VALUE}">${HIDDEN_SELECT_OPTION_TEXT}</option>
        <option value="referral">Referral</option>
      </select>
    </div>
  </div>
</div>`;

// A second, sibling prompt-selector field under the SAME `role=group` ancestor
// (well within MAX_SELECTION_ANCESTOR_DEPTH of src-widget) whose OWN hidden
// select is pre-populated with a value whose option text substring-matches
// OPTION — modeling a neighboring field the applicant already filled in
// before this step ran. Regression for the sibling-widget false-positive:
// the hidden-select corroboration must never credit src-widget's commit
// using a DIFFERENT widget's paired hidden select.
const SIBLING_WIDGET_HTML = `
<div data-automation-id="applyFlowMyInfoPage">
  <div role="group" aria-labelledby="source-section">
    <span id="source-section">${QUESTION_LABEL}</span>
    <div data-automation-id="formField-source">
      <div id="src-widget" role="combobox" aria-haspopup="listbox" aria-controls="src-popup"
           aria-invalid="true" tabindex="0"><span></span></div>
      <select id="hidden-sel" name="source" class="form-control dropdown-hide">
        <option value="">Select</option>
        <option value="${HIDDEN_SELECT_OPTION_VALUE}">${HIDDEN_SELECT_OPTION_TEXT}</option>
        <option value="referral">Referral</option>
      </select>
    </div>
    <div data-automation-id="formField-referral-source">
      <div id="referral-src-widget" role="combobox" aria-haspopup="listbox" aria-controls="referral-src-popup"
           aria-label="Referral Source" aria-invalid="false" tabindex="0"><span></span></div>
      <select id="referral-hidden-sel" name="referral-source" class="form-control dropdown-hide">
        <option value="">Select</option>
        <option value="${HIDDEN_SELECT_OPTION_VALUE}" selected>${HIDDEN_SELECT_OPTION_TEXT}</option>
      </select>
    </div>
  </div>
</div>`;

/**
 * A bespoke (not `buildPromptWidgetHarness`) harness: that shared helper
 * always writes the widget's own committed-value label node and clears
 * `aria-invalid` on commit, which would make the PRE-EXISTING readback pass
 * on its own and never exercise the new corroboration branch. This harness
 * commits ONLY into the paired hidden `<select>` (or, in the negative case,
 * nowhere at all) — the opener's own text/invalid-marker state never
 * changes either way, modeling the reported ambiguous-readback shape.
 */
function buildHarness(params: { commitsToHiddenSelect: boolean; withSiblingWidget?: boolean }): {
  page: unknown;
  target: FrameTarget;
  clicks: string[];
} {
  const window = new Window({ url: "https://careers.example.com/apply/job/1" });
  const document = window.document;
  document.body.innerHTML = params.withSiblingWidget ? SIBLING_WIDGET_HTML : WIDGET_HTML;

  // happy-dom's default `offsetParent` is `undefined`, not the browser's real
  // `null` for a `display:none` element — stand it in for "no layout box" so
  // `OPENER_PAIRED_HIDDEN_SELECT_EL_EXPR` (gated on `offsetParent === null`)
  // recognizes this select as the opener's hidden shadow control.
  const hiddenSelect = document.getElementById("hidden-sel") as unknown as Element;
  Object.defineProperty(hiddenSelect, "offsetParent", { value: null, configurable: true });
  if (params.withSiblingWidget) {
    const referralHiddenSelect = document.getElementById("referral-hidden-sel") as unknown as Element;
    Object.defineProperty(referralHiddenSelect, "offsetParent", { value: null, configurable: true });
  }

  const clicks: string[] = [];
  let popupOpen = false;

  const renderPopup = (): void => {
    const widgetEl = document.getElementById("src-widget") as Element;
    document.querySelector("[data-test-popup]")?.remove();
    const wrap = document.createElement("div");
    wrap.setAttribute("data-test-popup", "1");
    wrap.innerHTML = `<ul role="listbox">${OPTIONS.map(
      (o) => `<li role="option" data-automation-label="${o.label}">${o.label}</li>`
    ).join("")}</ul>`;
    widgetEl.appendChild(wrap);
    popupOpen = true;
  };

  const commit = (label: string): void => {
    document.querySelector("[data-test-popup]")?.remove();
    popupOpen = false;
    if (!params.commitsToHiddenSelect || label !== OPTION) return;
    const select = document.getElementById("hidden-sel") as unknown as {
      value: string;
      selectedIndex: number;
      options: ArrayLike<{ value: string }>;
    };
    const idx = Array.from(select.options).findIndex((o) => o.value === HIDDEN_SELECT_OPTION_VALUE);
    select.value = HIDDEN_SELECT_OPTION_VALUE;
    select.selectedIndex = idx;
  };

  const runExpr = (expr: string): unknown => {
    const fn = new window.Function("document", "window", "CSS", `return (${expr});`) as (
      d: unknown,
      w: unknown,
      c: unknown
    ) => unknown;
    return fn(document, window, window.CSS);
  };

  const resolveFirst = (selector: string): Element | null => {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  };

  const locator = (selector: string) => ({
    count: async (): Promise<number> => {
      try {
        return document.querySelectorAll(selector).length;
      } catch {
        return 0;
      }
    },
    first: () => ({
      click: async (): Promise<void> => {
        clicks.push(selector);
        const el = resolveFirst(selector);
        if (!el) return;
        const inOpenPopup = el.closest("[data-test-popup]") !== null;
        if (inOpenPopup && el.getAttribute("role") === "option") {
          commit(el.getAttribute("data-automation-label") || "");
          return;
        }
        if (!popupOpen) {
          renderPopup();
        } else {
          document.querySelector("[data-test-popup]")?.remove();
          popupOpen = false;
        }
      },
      fill: async (): Promise<void> => undefined,
      isChecked: async (): Promise<boolean> => false,
      inputValue: async (): Promise<string> => "",
    }),
  });

  const evaluate = async (expr: unknown): Promise<unknown> => runExpr(String(expr));

  const page = {
    evaluate,
    url: () => "https://careers.example.com/apply/job/1",
    title: async (): Promise<string> => "Apply",
    locator,
    waitForTimeout: async (): Promise<void> => undefined,
  };

  const target = {
    evaluate,
    locator,
    url: async (): Promise<string> => "https://careers.example.com/apply/job/1",
    title: async (): Promise<string> => "Apply",
    frame: null,
    frameSelector: null,
    declaredFrameSelector: null,
  } as unknown as FrameTarget;

  return { page, target, clicks };
}

function baseParams(page: Page, stagehand: Stagehand, step: string, frameTarget: unknown) {
  return {
    stagehand,
    page,
    frameTarget,
    step,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 10,
    phase: "apply",
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
    captureFn: vi.fn().mockResolvedValue(undefined),
    uploadFixture: null,
    isFinalStep: false,
    submitEndpointPattern: null,
    submittedStateSelectors: [],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: null,
    successUrlFragments: [],
    successPageTitleHints: [],
    ownBackendHostnames: [],
    knownErrorClassPrefixes: [],
    wizardExitButtonLabels: [],
  };
}

describe("flow-runner/commitPromptOption corroborates an ambiguous opener readback with the paired hidden select's value", () => {
  it("credits the widget when the opener's own text/invalid-marker readback is inconclusive but the paired hidden select's value now matches the chosen option", async () => {
    const stagehandAct = vi.fn();
    const stagehandObserve = vi.fn().mockResolvedValue([]);
    const stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;
    const { page, target } = buildHarness({ commitsToHiddenSelect: true });

    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const stepParams = baseParams(page as unknown as Page, stagehand, STEP, target);
    const stepResult = await executeStepWithHealing({
      ...stepParams,
      stepIndex: 20,
      trajectory,
    } as never);

    expect(stepResult).toBe("completed");
    expect(trajectory).toEqual([{ stepIndex: 20, verifiedBy: "dom", targetId: "src-widget" }]);
    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining(`selected "${OPTION}"`));
    // Resolved via the primitive's own DOM verification, never the act cascade.
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(stagehandObserve).not.toHaveBeenCalled();
  });

  it("does not credit the widget when NEITHER the opener text NOR the hidden select's value changed", async () => {
    const stagehandAct = vi.fn();
    const stagehandObserve = vi.fn().mockResolvedValue([]);
    const stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;
    const { page, target } = buildHarness({ commitsToHiddenSelect: false });

    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const stepParams = baseParams(page as unknown as Page, stagehand, STEP, target);
    await executeStepWithHealing({
      ...stepParams,
      stepIndex: 21,
      trajectory,
    } as never).catch(() => undefined);

    // The primitive's own readback never reports ok:true, so it never credits
    // this widget as `dom`-verified — the corroboration never fabricates a
    // commit that didn't happen.
    expect(trajectory).toEqual([]);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("did not commit; falling through to cascade")
    );
  });

  it("does not credit the widget using a SIBLING field's already-populated hidden select", async () => {
    const stagehandAct = vi.fn();
    const stagehandObserve = vi.fn().mockResolvedValue([]);
    const stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;
    const { page, target } = buildHarness({ commitsToHiddenSelect: false, withSiblingWidget: true });

    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const stepParams = baseParams(page as unknown as Page, stagehand, STEP, target);
    await executeStepWithHealing({
      ...stepParams,
      stepIndex: 22,
      trajectory,
    } as never).catch(() => undefined);

    // The sibling "referral-source" field's hidden select already holds a
    // value whose option text substring-matches OPTION, but it is paired
    // with the OTHER widget (referral-src-widget), not src-widget. The
    // corroboration must never cross-attribute it to src-widget's commit.
    expect(trajectory).toEqual([]);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("did not commit; falling through to cascade")
    );
  });
});
