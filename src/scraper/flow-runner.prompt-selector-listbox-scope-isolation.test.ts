import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for a page shaped like the report's: many sibling
 * combobox widgets, each portaling its own `role="listbox"` popup, plus
 * unrelated stray `role="listbox"` panels elsewhere on the page that belong
 * to no widget at all. Proves `PROMPT_SCOPE_ROOT_EXPR`'s aria-controls/
 * aria-owns-first resolution keeps enumerated options scoped to the CHOSEN
 * widget's own popup even when several sibling popups are simultaneously
 * mounted — never falling back to a document-wide query that would let a
 * same-named option from a stray or sibling listbox win by DOM order.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function baseParams(page: Page, stagehand: Stagehand, step: string, frameTarget: unknown) {
  return {
    stagehand,
    page,
    frameTarget,
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

const widgetGroup = (id: string, label: string, section: string): string => `
  <div role="group" aria-labelledby="${section}">
    <span id="${section}">${label}</span>
    <div data-automation-id="formField-${id}">
      <label for="${id}--input"><span>${label}</span></label>
      <div id="${id}" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer" aria-invalid="true">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="${id}--input" data-uxi-widget-type="selectinput" type="text"
               aria-required="true" value="" />
      </div>
    </div>
  </div>`;

/** A stray `role="listbox"` panel with no owning widget — decoy options collide by TEXT with a real widget's own options. */
const strayListbox = (id: string, options: string[]): string => `
  <ul id="${id}" role="listbox">
    ${options.map((o) => `<li role="option" data-automation-id="promptOption">${o}</li>`).join("")}
  </ul>`;

// 5 sibling openers, each with its own labelled combobox widget.
const FIVE_WIDGET_HTML = `
<div data-automation-id="applyFlowMyInfoPage">
  ${widgetGroup("w1", "Question One", "sec1")}
  ${widgetGroup("w2", "Question Two", "sec2")}
  ${widgetGroup("w3", "Question Three", "sec3")}
  ${widgetGroup("w4", "Question Four", "sec4")}
  ${widgetGroup("w5", "Question Five", "sec5")}
  ${strayListbox("stray-a", ["Epsilon", "Zeta"])}
  ${strayListbox("stray-b", ["Alpha", "Beta"])}
  ${strayListbox("stray-c", ["Iota", "Kappa"])}
</div>`;

describe("flow-runner/tryPromptSelectorPrimitive listbox scope isolation (multi-widget page)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes enumerated options to the chosen widget's own popup — 8 listbox panels, 5 openers, sibling popups already open", async () => {
    const stagehandAct = vi.fn();
    const stagehand = {
      act: stagehandAct,
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand;
    const { page, target } = buildPromptWidgetHarness({
      html: FIVE_WIDGET_HTML,
      popupByWidgetId: {
        w1: { options: ["Alpha", "Beta"], portaled: true },
        w2: { options: ["Gamma", "Delta"], portaled: true },
        // w3's own options intentionally share TEXT with the "stray-a" decoy
        // listbox above — a document-wide scope leak would resolve the decoy's
        // (earlier-in-DOM) copy of "Epsilon" instead of w3's own.
        w3: { options: ["Epsilon", "Zeta"], portaled: true },
        w4: { options: ["Eta", "Theta"], portaled: true },
        w5: { options: ["Iota", "Kappa"], portaled: true },
      },
    });

    // Open every sibling widget's popup first, leaving all 5 real listboxes
    // (plus the 3 stray decoys already in the markup — 8 role=listbox panels
    // total) mounted simultaneously, mirroring the report's multi-widget page.
    for (const id of ["w1", "w2", "w4", "w5"]) {
      await target.locator(`#${id}`).first().click();
    }

    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const params = baseParams(
      page as unknown as Page,
      stagehand,
      "for 'Question Three' select 'Epsilon'",
      target
    );

    const result = await executeStepWithHealing({ ...params, trajectory } as never);

    expect(result).toBe("completed");
    // Resolved and committed the CHOSEN widget (w3), not a stray/sibling.
    expect(trajectory).toEqual([{ stepIndex: 3, verifiedBy: "dom", targetId: "w3" }]);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('selected "Epsilon" for option "Epsilon"')
    );
    expect(testLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("did not commit"));
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("prompt-selector primitive: no")
    );
  });
});
