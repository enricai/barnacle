import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

/**
 * Site-agnostic-core proof: the same opener-drives / hidden-select-refused /
 * no-phantom-click chain the bb-customSelect acceptance test exercises must
 * hold for markup carrying NO recognizable design-system class name at all —
 * only the generic ARIA combobox-opener/hidden-select shape the primitives
 * are documented to key on (`PROMPT_TRIGGER_SELECTORS`,
 * `OPENER_PAIRED_HIDDEN_SELECT_EL_EXPR`). Proves the fix generalizes beyond
 * the one vendor shape the recon report happened to capture.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** Generic ARIA opener + hidden select, with an unrelated made-up class name. */
const COUNTRY_FIELD_HTML = `
<div>
  <span id="country-label">Country</span>
  <div class="widget-frame-outer">
    <span id="country-opener" class="widget-frame-outer__handle"
          role="combobox" aria-autocomplete="list" aria-expanded="false"
          aria-owns="country-panel" aria-activedescendant=""
          aria-labelledby="country-label" tabindex="0"><span></span></span>
    <select id="country-hidden" name="shadow-country"
            class="widget-frame-outer__shadow-input" aria-required="true">
      <option value="">Select</option>
      <option value="canada">Canada</option>
      <option value="mexico">Mexico</option>
      <option value="peru">Peru</option>
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

describe("flow-runner acceptance: a vendor-unmarked ARIA combobox opener + hidden select resolves generically", () => {
  it("drives the opener via ARIA alone, never writes the hidden select directly, and is never scored a phantom open-click", async () => {
    vi.clearAllMocks();
    const stagehandAct = vi.fn();
    const stagehandObserve = vi.fn().mockResolvedValue([]);
    const stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;
    const { page, target, window, clicks } = buildPromptWidgetHarness({
      html: COUNTRY_FIELD_HTML,
      popupByWidgetId: {
        "country-opener": {
          options: ["Canada", "Mexico", "Peru"],
          syncsHiddenSelectId: "country-hidden",
        },
      },
    });

    const hiddenSelectEl = window.document.getElementById("country-hidden");
    if (!hiddenSelectEl) throw new Error("fixture missing #country-hidden");
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
      `Select 'Peru' in the 'Country' dropdown`,
      target
    );

    const result = await executeStepWithHealing({ ...params, trajectory } as never);

    expect(result).toBe("completed");
    // Resolved via the prompt-selector primitive driving the opener — never
    // the select primitive, and never Stagehand's act/observe cascade — even
    // though nothing in the markup names any known widget library.
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by select primitive")
    );
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(stagehandObserve).not.toHaveBeenCalled();
    expect(trajectory).toEqual([{ stepIndex: 5, verifiedBy: "dom", targetId: "country-opener" }]);

    // The open-click step was never scored a phantom click: it resolved via
    // the "dom" verifier and completed, not rejected/retried as unverifiable.
    expect(testLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining("phantom"));

    // The opener's own committed state reflects "Peru" — the widget the
    // primitive actually drove.
    expect(
      window.document.querySelector("#country-opener [data-automation-id='promptSelectionLabel']")
        ?.textContent
    ).toBe("Peru");

    // The hidden select was written to EXACTLY ONCE, and only after both the
    // opener's trigger click AND its option click had already happened
    // (clicksAtWrite >= 2) — i.e. synced as a consequence of the opener being
    // driven, never written to directly by trySelectPrimitive.
    expect(hiddenSelectWrites).toHaveLength(1);
    expect(hiddenSelectWrites[0]?.clicksAtWrite).toBeGreaterThanOrEqual(2);
    expect(hiddenSelectWrites[0]?.value).toBe("peru");
    expect((hiddenSelectEl as unknown as { value: string }).value).toBe("peru");
  });
});
