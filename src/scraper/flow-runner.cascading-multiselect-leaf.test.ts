import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

/**
 * bugfix-003: end-to-end regression for docs/recon-cascading-multiselect-leaf-not-committed.md's
 * exact manual-verification outcome — the category step and the leaf step
 * authored as two SEPARATE flow steps against the SAME widget, driven through
 * `executeStepWithHealing` against the shared `drillTo`-capable DOM harness
 * (bugfix-001), must BOTH resolve via `tryPromptSelectorPrimitive` (never the
 * observe cascade's `el.click()` fallback), and the widget's final committed
 * value must be the LEAF option with its invalid marker cleared. This proves
 * bugfix-001 (harness) and bugfix-002 (the primitive's drill fix) together
 * close the reported symptom.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const CATEGORY = "Job Boards";
const LEAF = "Internet - Job Boards/Search Engines";
const CATEGORIES = ["Advertising", "CVS", CATEGORY, "Job Fair", "Military", "Networking"];
const LEAVES = ["Glassdoor", "IndeedEasyApply", LEAF, "irishjobs"];

const WIDGET_HTML = `
<div data-automation-id="applyFlowMyInfoPage">
  <div role="group" aria-labelledby="source-section">
    <span id="source-section">Contact</span>
    <div data-automation-id="formField-source">
      <label for="source--source"><span>How Did You Hear About Us?</span></label>
      <div id="src-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="source--source" data-uxi-widget-type="selectinput" type="text"
               aria-required="true" aria-invalid="true" value="" />
      </div>
    </div>
  </div>
</div>`;

const popupByWidgetId = {
  "src-widget": {
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

describe("flow-runner/tryPromptSelectorPrimitive two-step cascading multiselect leaf regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the category step then the leaf step via the primitive and commits the leaf, with the invalid marker cleared", async () => {
    const stagehandAct = vi.fn();
    const stagehandObserve = vi.fn().mockResolvedValue([]);
    const stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;
    const { page, target } = buildPromptWidgetHarness({ html: WIDGET_HTML, popupByWidgetId });

    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];

    const categoryResult = await executeStepWithHealing({
      ...baseParams(
        page as unknown as Page,
        stagehand,
        `for 'How Did You Hear About Us?' select '${CATEGORY}'`,
        target
      ),
      stepIndex: 10,
      trajectory,
    } as never);
    expect(categoryResult).toBe("completed");
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );

    const leafResult = await executeStepWithHealing({
      ...baseParams(
        page as unknown as Page,
        stagehand,
        `for 'How Did You Hear About Us?' select '${LEAF}'`,
        target
      ),
      stepIndex: 11,
      trajectory,
    } as never);
    expect(leafResult).toBe("completed");

    // Both steps resolved via the primitive (dom-verified) — never fell
    // through to the observe cascade.
    expect(trajectory).toEqual([
      { stepIndex: 10, verifiedBy: "dom", targetId: "src-widget" },
      { stepIndex: 11, verifiedBy: "dom", targetId: "src-widget" },
    ]);
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(stagehandObserve).not.toHaveBeenCalled();

    // Final widget state reflects the leaf option as committed — readback
    // ok, invalid cleared.
    const widget = (target as unknown as { evaluate: (e: string) => Promise<unknown> }).evaluate;
    const finalState = (await widget(
      `((() => { const w = document.getElementById("src-widget"); return { text: w.querySelector("[data-automation-id='promptSelectionLabel']").textContent, invalid: w.querySelector("input").getAttribute("aria-invalid") }; })())`
    )) as { text: string; invalid: string };
    expect(finalState.text).toBe(LEAF);
    expect(finalState.invalid).toBe("false");
  });
});
