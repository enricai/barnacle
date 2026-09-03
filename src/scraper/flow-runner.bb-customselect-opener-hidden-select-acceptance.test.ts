import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

/**
 * End-to-end acceptance test for the recon report's Base Web `bb-customSelect`
 * shape: a visible `role=combobox` opener (`aria-owns` a listbox panel,
 * `tabindex="0"`) paired with a sibling hidden `<select class="dropdown-hide">`
 * carrying the real `<option>` text. Proves the whole chain the report's fix
 * touches actually closes end to end through `executeStepWithHealing`, not
 * just at each unit boundary: `trySelectPrimitive` (bugfix-002) refuses the
 * hidden select, `tryPromptSelectorPrimitive` drives and verifies the opener,
 * and — mirroring "Base Web syncs the opener text AND the hidden `<select>`"
 * (report, Appendix) — the hidden select ends up synced to the choice only
 * AFTER the opener itself was actuated, never written to directly by either
 * primitive.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** The report's exact markup shape for the State/Province field. */
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
      <option value="alabama">Alabama</option>
      <option value="alaska">Alaska</option>
      <option value="georgia">Georgia</option>
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

describe("flow-runner acceptance: bb-customSelect-shaped select step resolves via the opener, not the hidden select", () => {
  it("drives the opener, never writes the hidden select directly, and the hidden select ends up synced to the choice only after actuation", async () => {
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

    // happy-dom implements no layout engine, so `offsetParent` never reflects
    // `dropdown-hide`'s CSS — stand it in for the browser's real
    // `display:none` null, the same idiom bugfix-002's own test uses. Also
    // instrument writes to the hidden select's `value`, recording how many
    // clicks the harness had already recorded at each write — this is what
    // proves the ONE write that happens is the harness's post-actuation sync,
    // not a direct write from either primitive.
    const hiddenSelectEl = window.document.getElementById("state-hidden");
    if (!hiddenSelectEl) throw new Error("fixture missing #state-hidden");
    Object.defineProperty(hiddenSelectEl, "offsetParent", { value: null, configurable: true });
    let hiddenSelectValue = "";
    const hiddenSelectWrites: { value: string; clicksAtWrite: number }[] = [];
    Object.defineProperty(hiddenSelectEl, "value", {
      get: () => hiddenSelectValue,
      set: (v: string) => {
        hiddenSelectValue = v;
        hiddenSelectWrites.push({ value: v, clicksAtWrite: clicks.length });
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
    // Resolved via the prompt-selector primitive driving the opener — never
    // the select primitive (which must refuse the opener-paired hidden
    // select, bugfix-002), and never Stagehand's act/observe cascade.
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by select primitive")
    );
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(stagehandObserve).not.toHaveBeenCalled();
    expect(trajectory).toEqual([{ stepIndex: 5, verifiedBy: "dom", targetId: "state-opener" }]);

    // The opener's own committed state reflects "Georgia" — the widget the
    // primitive actually drove.
    expect(
      window.document.querySelector("#state-opener [data-automation-id='promptSelectionLabel']")
        ?.textContent
    ).toBe("Georgia");

    // The hidden select was written to EXACTLY ONCE, and that write landed
    // only after both the opener's trigger click AND its option click had
    // already happened (clicksAtWrite >= 2) — i.e. it was synced as a
    // consequence of the opener being driven, never written to directly
    // by trySelectPrimitive (which would write it with zero prior clicks)
    // or by any other actuation path.
    expect(hiddenSelectWrites).toHaveLength(1);
    expect(hiddenSelectWrites[0]?.clicksAtWrite).toBeGreaterThanOrEqual(2);
    expect(hiddenSelectWrites[0]?.value).toBe("georgia");
    expect((hiddenSelectEl as unknown as { value: string }).value).toBe("georgia");
  });
});
