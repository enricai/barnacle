import type Anthropic from "@anthropic-ai/sdk";
import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { judgeSelectOptionWithLLM } from "@/lib/llm/judges/select-option";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/select-option", () => ({
  judgeSelectOptionWithLLM: vi.fn(),
}));

/**
 * Regression for the category-click readback false positive: a single flow
 * step that names only the LEAF of a two-level cascading category/leaf
 * multiselect, on a widget that never sets `aria-invalid` (only validated at
 * final submit). The first click lands on the category — drilling the popup
 * to leaves without committing anything — so `textMatches=false` and
 * `stillInvalid=false`. Before the fix that pair alone reported `ok: true`
 * and returned right after the category click; the leaf was never clicked.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const CATEGORY = "Phone";
const LEAF = "After-Hours Mobile Line";
const CATEGORIES = ["Email", CATEGORY, "Postal Mail"];
const LEAVES = ["Work Landline", LEAF, "Voicemail Only"];

const WIDGET_HTML = `
<div data-automation-id="contactPreferencesPage">
  <div role="group" aria-labelledby="channel-section">
    <span id="channel-section">Contact</span>
    <div data-automation-id="formField-channel">
      <label for="channel--channel"><span>Preferred Contact Channel</span></label>
      <div id="channel-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="channel--channel" data-uxi-widget-type="selectinput" type="text"
               aria-required="true" value="" />
      </div>
    </div>
  </div>
</div>`;

const popupByWidgetId = {
  "channel-widget": {
    options: CATEGORIES.map((c) =>
      c === CATEGORY ? { label: c, drillTo: { options: LEAVES } } : c
    ),
  },
};

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

describe("flow-runner/tryPromptSelectorPrimitive category-click readback on a widget with no aria-invalid marker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not short-circuit on the category click; drills to and commits the leaf", async () => {
    const stagehandAct = vi.fn();
    const stagehandObserve = vi.fn().mockResolvedValue([]);
    const stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;
    const { page, target } = buildPromptWidgetHarness({ html: WIDGET_HTML, popupByWidgetId });

    vi.mocked(judgeSelectOptionWithLLM).mockResolvedValue({
      selectIndex: 0,
      optionIndex: CATEGORIES.indexOf(CATEGORY),
      reason: "closest category for the leaf hint",
    });

    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const stepResult = await executeStepWithHealing({
      ...baseParams(
        page as unknown as Page,
        stagehand,
        `for 'Preferred Contact Channel' select '${LEAF}'`,
        target
      ),
      anthropic: {} as unknown as Anthropic,
      stepIndex: 30,
      trajectory,
    } as never);

    expect(stepResult).toBe("completed");
    // The category click alone must NOT be reported as success — the
    // primitive must re-enumerate the drilled option set and continue.
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("drilled the popup to a new option set")
    );
    expect(trajectory).toEqual([{ stepIndex: 30, verifiedBy: "dom", targetId: "channel-widget" }]);

    const widget = (target as unknown as { evaluate: (e: string) => Promise<unknown> }).evaluate;
    const finalState = (await widget(
      `((() => { const w = document.getElementById("channel-widget"); return { text: w.querySelector("[data-automation-id='promptSelectionLabel']").textContent }; })())`
    )) as { text: string };
    // Final committed value is the LEAF, never the category.
    expect(finalState.text).toBe(LEAF);
    expect(finalState.text).not.toBe(CATEGORY);

    expect(stagehandAct).not.toHaveBeenCalled();
    expect(stagehandObserve).not.toHaveBeenCalled();
  });
});
