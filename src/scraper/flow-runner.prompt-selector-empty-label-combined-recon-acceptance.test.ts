import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

/**
 * Acceptance test for the recon report's exact COMBINED failure shape, all
 * three fixes at once, in one realistic DOM: a `bb-customSelect`-shaped
 * opener whose `role=option` elements render with EMPTY own textContent/
 * data-value (label resolvable only via `aria-labelledby`) paired with a sibling
 * hidden `dropdown-hide` `<select>` whose every `<option>` also carries an
 * EMPTY value, alongside a second, independent `bb-customSelect`-shaped
 * field for a different question on the same page. `flow-runner.
 * bb-customselect-opener-hidden-select-acceptance.test.ts` pins the opener-
 * vs-hidden-select refusal in isolation; `flow-runner.prompt-selector-
 * empty-valued-shadow-select-verification.test.ts` pins empty select values
 * alone; `flow-runner.prompt-selector-sibling-listbox-scope.test.ts` pins
 * sibling scoping alone. None of them combine empty-labelled OPTIONS with an
 * empty-valued PAIRED select AND a sibling widget in a single DOM — this is
 * the report's actual step-12 shape, and the direct proof the whole chain
 * closes end to end through `executeStepWithHealing` on the FIRST attempt,
 * never falling through to the act/observe cascade.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/**
 * Two independent `bb-customSelect`-shaped fields on one consent-style page:
 * "Marketing Consent" (the field the step targets) and a sibling "Contact
 * Preference" field for a different question. Both pair a visible
 * `role=combobox` opener with a sibling hidden `dropdown-hide` `<select>`
 * whose every `<option value="">` is empty (the report's empty-values
 * shape) — the opener's own rendered `role=option` elements (added by the
 * harness's `labelVia` popup spec) likewise carry no own text/data-value.
 */
const CONSENT_FORM_HTML = `
<div>
  <span id="consent-label">Marketing Consent</span>
  <div class="bb-custom-select-container bb-customSelect">
    <span id="consent-opener" class="bb-custom-select-opener"
          role="combobox" aria-autocomplete="list" aria-expanded="false"
          aria-owns="consent-panel" aria-activedescendant=""
          aria-labelledby="consent-label" tabindex="0"><span></span></span>
    <select id="consent-hidden" name="rcf-consent"
            class="iCIMS_Forms_RequiredField form-control dropdown-hide" aria-required="true">
      <option value="">Select</option>
      <option value="">Yes</option>
      <option value="">No</option>
    </select>
  </div>
</div>
<div>
  <span id="preference-label">Contact Preference</span>
  <div class="bb-custom-select-container bb-customSelect">
    <span id="preference-opener" class="bb-custom-select-opener"
          role="combobox" aria-autocomplete="list" aria-expanded="false"
          aria-owns="preference-panel" aria-activedescendant=""
          aria-labelledby="preference-label" tabindex="0"><span></span></span>
    <select id="preference-hidden" name="rcf-preference"
            class="iCIMS_Forms_RequiredField form-control dropdown-hide" aria-required="true">
      <option value="">Select</option>
      <option value="">Email</option>
      <option value="">Phone</option>
    </select>
  </div>
</div>`;

function baseParams(page: Page, stagehand: Stagehand, step: string, frameTarget: unknown) {
  return {
    stagehand,
    page,
    frameTarget,
    step,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 5,
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

describe("flow-runner acceptance: combined empty-labelled options + empty-valued paired select + sibling widget (recon step-12 shape)", () => {
  it("resolves 'No' for Marketing Consent via the prompt-selector primitive on the first attempt, without the cascade and without touching the sibling field", async () => {
    vi.clearAllMocks();
    const stagehandAct = vi.fn();
    const stagehandObserve = vi.fn().mockResolvedValue([]);
    const stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;
    const { page, target, window, clicks } = buildPromptWidgetHarness({
      html: CONSENT_FORM_HTML,
      popupByWidgetId: {
        "consent-opener": {
          options: [
            { label: "Yes", labelVia: "aria-labelledby" },
            { label: "No", labelVia: "aria-labelledby" },
          ],
          syncsHiddenSelectId: "consent-hidden",
        },
        "preference-opener": {
          options: [
            { label: "Email", labelVia: "aria-labelledby" },
            { label: "Phone", labelVia: "aria-labelledby" },
          ],
          syncsHiddenSelectId: "preference-hidden",
        },
      },
    });

    // happy-dom implements no layout engine — stand offsetParent-null in for
    // `dropdown-hide`'s real CSS, same idiom the paired acceptance test uses,
    // on BOTH hidden selects.
    for (const id of ["consent-hidden", "preference-hidden"]) {
      const el = window.document.getElementById(id);
      if (!el) throw new Error(`fixture missing #${id}`);
      Object.defineProperty(el, "offsetParent", { value: null, configurable: true });
    }

    const preferenceHiddenWrites: string[] = [];
    const preferenceHiddenEl = window.document.getElementById("preference-hidden");
    if (!preferenceHiddenEl) throw new Error("fixture missing #preference-hidden");
    let preferenceHiddenValue = "";
    Object.defineProperty(preferenceHiddenEl, "value", {
      get: () => preferenceHiddenValue,
      set: (v: string) => {
        preferenceHiddenValue = v;
        preferenceHiddenWrites.push(v);
      },
      configurable: true,
    });

    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const params = baseParams(
      page as unknown as Page,
      stagehand,
      "Select 'No' for 'Marketing Consent'",
      target
    );

    const result = await executeStepWithHealing({ ...params, trajectory } as never);

    expect(result).toBe("completed");
    // Resolved by the prompt-selector primitive on the FIRST attempt — no
    // cascade fallback logged, never the select primitive (which must refuse
    // the opener-paired hidden select), never Stagehand's act/observe.
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by select primitive")
    );
    expect(testLogger.warn).not.toHaveBeenCalled();
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(stagehandObserve).not.toHaveBeenCalled();
    expect(trajectory).toEqual([{ stepIndex: 5, verifiedBy: "dom", targetId: "consent-opener" }]);

    // The consent opener's own committed state reflects "No".
    expect(
      window.document.querySelector("#consent-opener [data-automation-id='promptSelectionLabel']")
        ?.textContent
    ).toBe("No");

    // The sibling "Contact Preference" field — same empty-labelled-option,
    // empty-valued-select shape — was never touched: no click landed inside
    // its own popup/opener, its hidden select was never written, and its
    // opener carries no committed value.
    expect(clicks.some((sel) => sel.includes("preference"))).toBe(false);
    expect(preferenceHiddenWrites).toHaveLength(0);
    expect(
      window.document.querySelector(
        "#preference-opener [data-automation-id='promptSelectionLabel']"
      )?.textContent
    ).toBeUndefined();
  });
});
