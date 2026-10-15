import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/select-option", () => ({
  judgeSelectOptionWithLLM: vi.fn(),
}));

/**
 * A typeahead whose result list re-renders twice after Enter, reusing the same
 * DOM nodes with different text (a virtualized list). The primitive must commit
 * only from a list that has stopped changing and click the node that carries the
 * requested option's text at click time, not a stale position mark.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const VIRTUALIZED_HTML = `
<div data-automation-id="residencePage">
  <div role="group" aria-labelledby="residence-section">
    <span id="residence-section">Residence</span>
    <div data-automation-id="formField-country">
      <label for="country--country"><span>Country of residence</span></label>
      <div id="country-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
        <div data-automation-id="multiselectInputContainer">
          <input id="country--country" data-uxi-widget-type="selectinput" type="text"
                 placeholder="Search" aria-required="true" aria-invalid="true" value="" />
        </div>
        <div data-automation-id="promptSelectionLabel"></div>
        <div aria-live="polite" data-automation-id="promptAriaInstruction">0 items selected</div>
      </div>
    </div>
  </div>
</div>`;

const OPTIONS = ["Norway", "Sweden", "Denmark"];
const RENDERS = [
  ["Denmark", "Norway", "Sweden"],
  ["Sweden", "Denmark", "Norway"],
];

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

describe("flow-runner/tryPromptSelectorPrimitive virtualized list (real DOM)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("commits the requested option after node-reusing re-renders, clicking the node whose text matches", async () => {
    const stagehandAct = vi.fn();
    const { page, target, window } = buildPromptWidgetHarness({
      html: VIRTUALIZED_HTML,
      popupByWidgetId: {
        "country-widget": { options: OPTIONS, searchOnSubmit: true, reuseRenders: RENDERS },
      },
    });
    const clickedTexts: string[] = [];
    type Loc = { click: () => Promise<void> };
    const recording =
      (original: (s: string) => unknown) =>
      (selector: string): unknown => {
        const loc = original(selector) as Loc;
        return {
          ...loc,
          click: async (): Promise<void> => {
            const node = window.document.querySelector(selector);
            if (node?.getAttribute("role") === "option") {
              clickedTexts.push(node.textContent?.trim() ?? "");
            }
            await loc.click();
          },
        };
      };
    const pageLoc = page as unknown as { locator: (s: string) => unknown };
    pageLoc.locator = recording(pageLoc.locator);
    const targetLoc = target as unknown as { locator: (s: string) => unknown };
    targetLoc.locator = recording(targetLoc.locator);
    const merged = {
      ...baseParams(page as unknown as Page, stagehandAct, ""),
      frameTarget: target,
      step: "for 'Country of residence' select 'Sweden'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(clickedTexts).toEqual(["Sweden"]);
    const committed = window.document.querySelector(
      "[data-automation-id='promptSelectionLabel']"
    )?.textContent;
    expect(committed).toBe("Sweden");
  });
});
