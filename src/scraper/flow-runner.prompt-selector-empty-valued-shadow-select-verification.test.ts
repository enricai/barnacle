import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

/**
 * Regression test for the recon report's "empty option values" shape: a
 * combobox opener paired (via a sibling hidden `<select>`) whose every
 * `<option value="">` carries an empty value — so the select's own `value`/
 * `selectedIndex` can never corroborate a choice. Proves the readback in
 * `executeStepWithHealing`'s verification expression (see the
 * `hiddenSelectMatches` block, flow-runner.ts around the `readbackExpr`
 * builder, which skips a paired select entirely once `(sel.value || "").trim()`
 * is empty) still resolves the commit through the opener's own displayed
 * text/`aria-activedescendant`, and that the select primitive (see
 * `OPENER_PAIRED_HIDDEN_SELECT_EL_EXPR`, flow-runner.ts) refuses this select
 * as a candidate rather than attempting and rejecting a write to it.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** Same shape as the acceptance test's State/Province field, but every option's `value=""`. */
const STATE_FIELD_HTML = `
<div>
  <span id="state-label">State/Province</span>
  <div class="bb-custom-select-container bb-customSelect">
    <span id="state-opener" class="bb-custom-select-opener"
          role="combobox" aria-autocomplete="list" aria-expanded="false"
          aria-owns="state-panel" aria-activedescendant=""
          aria-labelledby="state-label" tabindex="0"><span></span></span>
    <select id="state-hidden" name="rcf-state"
            class="iCIMS_Forms_RequiredField form-control dropdown-hide" aria-required="true">
      <option value="">Select</option>
      <option value="">Alabama</option>
      <option value="">Alaska</option>
      <option value="">Georgia</option>
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

describe("flow-runner regression: empty-valued shadow select never corroborates or is written to", () => {
  it("resolves via the opener's own text, refuses the select primitive, and never writes the hidden select's value before the opener's own value is already correct", async () => {
    vi.clearAllMocks();
    const stagehandAct = vi.fn();
    const stagehandObserve = vi.fn().mockResolvedValue([]);
    const stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;
    const { page, target, window, clicks } = buildPromptWidgetHarness({
      html: STATE_FIELD_HTML,
      popupByWidgetId: {
        "state-opener": {
          options: ["Alabama", "Alaska", "Georgia"],
          syncsHiddenSelectId: "state-hidden",
        },
      },
    });

    const hiddenSelectEl = window.document.getElementById("state-hidden");
    if (!hiddenSelectEl) throw new Error("fixture missing #state-hidden");
    Object.defineProperty(hiddenSelectEl, "offsetParent", { value: null, configurable: true });

    // Instrument the hidden select's `value` setter to record, for every
    // write, whether the opener's own committed label already read "Georgia"
    // AT THE TIME of that write — this is what proves the opener was actuated
    // (and its own readback already satisfied) BEFORE any write to the select
    // landed, i.e. the select was never the deciding signal.
    let hiddenSelectValue = "";
    const hiddenSelectWrites: { value: string; clicksAtWrite: number; openerAlreadyCorrect: boolean }[] = [];
    Object.defineProperty(hiddenSelectEl, "value", {
      get: () => hiddenSelectValue,
      set: (v: string) => {
        const openerLabel = window.document.querySelector(
          "#state-opener [data-automation-id='promptSelectionLabel']"
        )?.textContent;
        hiddenSelectValue = v;
        hiddenSelectWrites.push({
          value: v,
          clicksAtWrite: clicks.length,
          openerAlreadyCorrect: openerLabel === "Georgia",
        });
      },
      configurable: true,
    });

    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const params = baseParams(
      page as unknown as Page,
      stagehand,
      `Select 'Georgia' in the 'State/Province' dropdown`,
      target
    );

    const result = await executeStepWithHealing({ ...params, trajectory } as never);

    expect(result).toBe("completed");
    // Resolved via the opener's own readback, never the select primitive
    // (which must refuse an opener-paired hidden select outright) and never
    // Stagehand's act/observe cascade.
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by select primitive")
    );
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(stagehandObserve).not.toHaveBeenCalled();
    expect(trajectory).toEqual([{ stepIndex: 5, verifiedBy: "dom", targetId: "state-opener" }]);

    expect(
      window.document.querySelector("#state-opener [data-automation-id='promptSelectionLabel']")
        ?.textContent
    ).toBe("Georgia");

    // The select's own value/selectedIndex can never corroborate a choice
    // here — every option's value is "" — so `hiddenSelectMatches` in the
    // readback expression must never have been the deciding signal: the
    // ONLY write to the select is the harness's post-actuation sync, which
    // lands after both opener clicks (clicksAtWrite >= 2) and after the
    // opener's own label was ALREADY "Georgia" (openerAlreadyCorrect true) —
    // proving the write never preceded (and therefore never drove) the
    // opener-based readback that resolved the step.
    expect(hiddenSelectWrites).toHaveLength(1);
    expect(hiddenSelectWrites[0]?.clicksAtWrite).toBeGreaterThanOrEqual(2);
    expect(hiddenSelectWrites[0]?.openerAlreadyCorrect).toBe(true);
    expect(hiddenSelectWrites[0]?.value).toBe("");
    expect((hiddenSelectEl as unknown as { value: string }).value).toBe("");
  });
});
