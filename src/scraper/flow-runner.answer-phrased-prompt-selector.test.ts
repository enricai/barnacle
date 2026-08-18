import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

/**
 * Pins a specific gap: a flow step phrased as "click the '<option>' answer for
 * ..." (a radio-style verb) resolves via the dispatch chain when the underlying
 * control is a widget-kit prompt-selector (data-uxi-widget-type, no native
 * `input[type=radio]`) rather than falling through to the observe cascade.
 * `parseSelectStep` only matches the literal word "select" and the radio
 * primitive only enumerates native radios, so this proves the widget-shape
 * check ahead of the verb check routes answer-phrased steps correctly.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function actResult(overrides: Partial<ActResult> = {}): ActResult {
  return {
    success: true,
    message: "clicked",
    actionDescription: "clicked",
    actions: [],
    ...overrides,
  };
}

/**
 * A widget-kit Yes/No control: trigger is a
 * `<input data-uxi-widget-type="selectinput">` inside a
 * `data-uxi-widget-type="multiselect"` container, current value in a
 * `promptSelectionLabel` node — zero native `input[type=radio]` elements render
 * anywhere in the fixture.
 */
const WIDGET_KIT_YESNO_HTML = `
<div>
  <div role="group" aria-labelledby="eligibility-section">
    <span id="eligibility-section">Eligibility</span>
    <div data-automation-id="formField-eligibility">
      <label for="eligibility--eligibility"><span>Are you legally authorized to work?</span></label>
      <div id="eligibility-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="eligibility--eligibility" data-uxi-widget-type="selectinput" type="text"
               placeholder="Search" aria-required="true" aria-invalid="true" value="" />
      </div>
    </div>
  </div>
</div>`;

function baseParams(page: Page, stagehandAct: ReturnType<typeof vi.fn>, step: string) {
  const stagehand = {
    act: stagehandAct,
    observe: vi.fn().mockResolvedValue([]),
  } as unknown as Stagehand;
  return {
    stagehand,
    page,
    step,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 3,
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

describe("flow-runner/tryPromptSelectorPrimitive (answer-phrased steps, no native radios)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves 'click the Yes answer for ...' against a widget-kit Yes/No control with zero native radios", async () => {
    const stagehandAct = vi.fn();
    const { page, target, window, clicks } = buildPromptWidgetHarness({
      html: WIDGET_KIT_YESNO_HTML,
      popupByWidgetId: { "eligibility-widget": { options: ["Yes", "No"] } },
    });
    // Guard the fixture's own premise: no native radio inputs render at all.
    expect(window.document.querySelectorAll('input[type="radio"]').length).toBe(0);
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      frameTarget: target,
      step: "Click the 'Yes' answer for the question 'Are you legally authorized to work?'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(stagehandAct).not.toHaveBeenCalled();
    // At least a trigger click and an option click happened — a dom-verified
    // trajectory entry, not a fall-through to the observe cascade.
    expect(clicks.length).toBeGreaterThanOrEqual(2);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("falls through to the cascade when no popup registers for the widget (control proof: the harness itself can fail)", async () => {
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const { page, target } = buildPromptWidgetHarness({
      html: WIDGET_KIT_YESNO_HTML,
      popupByWidgetId: {},
    });
    const stagehand = {
      act: stagehandAct,
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand;
    const params = { ...baseParams(page as unknown as Page, stagehandAct, ""), stagehand };
    const merged = {
      ...params,
      frameTarget: target,
      step: "Click the 'Yes' answer for the question 'Are you legally authorized to work?'",
    };

    await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    ).catch(() => undefined);

    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });
});
