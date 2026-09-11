import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing, verifyPromptSelectorCommitted } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/select-option", () => ({
  judgeSelectOptionWithLLM: vi.fn(),
}));

/**
 * Regression coverage for a `role="option"` element with NO own accessible
 * text (empty `textContent`/`data-value`) whose label instead lives on
 * `aria-label`, `aria-labelledby`, `title`, or a descendant node. Previously
 * the enumeration read and the commit-verification readback both fell back to
 * raw `textContent`, so such an option could never be matched OR confirmed as
 * committed, even though the widget family renders and behaves identically to
 * one whose option text is inline.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/**
 * A near-standard `<button aria-haspopup="listbox">` widget whose popup
 * options carry NO own text/`data-value` — the accessible name lives on
 * `aria-labelledby` instead, per `labelVia`.
 */
const ARIA_BUTTON_HTML = `
<div>
  <div role="group" aria-labelledby="dept-section">
    <span id="dept-section">Team</span>
    <label for="deptType"><span>Department</span></label>
    <button id="deptType" aria-haspopup="listbox" type="button"
            aria-invalid="true" aria-label="Department Required"></button>
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

describe("flow-runner/tryPromptSelectorPrimitive (empty-own-label option)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("matches and selects an option whose own text/data-value is empty but whose label is carried on aria-labelledby", async () => {
    const stagehandAct = vi.fn();
    const { page, target } = buildPromptWidgetHarness({
      html: ARIA_BUTTON_HTML,
      popupByWidgetId: {
        deptType: {
          options: [
            { label: "Engineering", labelVia: "aria-labelledby" },
            { label: "Marketing", labelVia: "aria-labelledby" },
          ],
          portaled: true,
        },
      },
    });
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      frameTarget: target,
      step: "for 'Department' select 'Marketing'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    // Enumeration resolved a non-empty label for the empty-own-text option,
    // so the deterministic matcher found it without ever falling to the LLM.
    expect(result).toBe("completed");
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("reports commit-verified via the aria-activedescendant readback using the resolved label, with no paired shadow select", async () => {
    // A committed `role=combobox` widget whose `aria-activedescendant` points
    // at a mounted option with empty own text/data-value — the label lives
    // on an `aria-labelledby`-referenced node instead, modeling a widget-kit
    // whose committed option renders the same way it does while open.
    const html = `
      <div role="combobox" id="deptCombo" aria-haspopup="listbox"
           aria-activedescendant="dept-opt-1">
        <ul role="listbox">
          <span id="dept-opt-1-label" hidden>Marketing</span>
          <div id="dept-opt-1" role="option" data-value="" aria-labelledby="dept-opt-1-label"></div>
        </ul>
      </div>`;
    const { target } = buildPromptWidgetHarness({ html, popupByWidgetId: {} });

    const result = await verifyPromptSelectorCommitted(target, "//*[@id='deptCombo']");

    expect(result).toEqual({ isPromptWidget: true, committed: true });
  });
});
