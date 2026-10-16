import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { PopupSpec } from "@/scraper/prompt-widget-dom-harness.test-helper";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/select-option", () => ({
  judgeSelectOptionWithLLM: vi.fn(),
}));

/**
 * A result list that re-renders in place (same nodes, different text) must never
 * commit a value other than the requested option, whether the list is loaded by
 * Enter or filters as you type.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const WIDGET_HTML = `
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

const TWICE = [
  ["Denmark", "Norway", "Sweden"],
  ["Sweden", "Denmark", "Norway"],
];
const NEAR_OPTIONS = ["Denmark", "Denmark Island"];
const ONCE = [["Denmark Island", "Denmark"]];

const MODES: [string, Partial<PopupSpec>][] = [
  ["Enter-loaded", { searchOnSubmit: true }],
  ["as-you-type", { searchable: true }],
];

async function selectCountry(
  spec: PopupSpec,
  option: string
): Promise<{ result: unknown; committed: string; enters: number }> {
  const stagehandAct = vi.fn();
  const { page, target, window, cdpEvents } = buildPromptWidgetHarness({
    html: WIDGET_HTML,
    popupByWidgetId: { "country-widget": spec },
  });
  const result = await executeStepWithHealing({
    stagehand: {
      act: stagehandAct,
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand,
    page: page as unknown as Page,
    frameTarget: target,
    step: `for 'Country of residence' select '${option}'`,
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
  } as never);
  const enters = cdpEvents.filter((e) => {
    const p = e.params as { type?: string; key?: string } | undefined;
    return e.method === "Input.dispatchKeyEvent" && p?.type === "keyDown" && p.key === "Enter";
  }).length;
  expect(stagehandAct).not.toHaveBeenCalled();
  const committed =
    window.document.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent ?? "";
  return { result, committed, enters };
}

describe("flow-runner/tryPromptSelectorPrimitive in-place re-renders (real DOM)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const [name, mode] of MODES) {
    it(`${name}: commits the requested option after two in-place re-renders`, async () => {
      const { result, committed, enters } = await selectCountry(
        { options: OPTIONS, ...mode, reuseRenders: TWICE },
        "Sweden"
      );

      expect(result).toBe("completed");
      expect(committed).toBe("Sweden");
      expect(enters).toBe(mode.searchOnSubmit ? 1 : 0);
    });

    it(`${name}: commits the requested option after a single re-render for another option`, async () => {
      const { result, committed } = await selectCountry(
        { options: NEAR_OPTIONS, ...mode, reuseRenders: ONCE },
        "Denmark"
      );

      expect(result).toBe("completed");
      expect(committed).toBe("Denmark");
    });
  }
});
