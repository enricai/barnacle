import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/select-option", () => ({
  judgeSelectOptionWithLLM: vi.fn(),
}));

/**
 * A typeahead that renders only a "No Items." placeholder after the filter is
 * typed and loads real options on a trusted Enter keyDown. The primitive must
 * send that Enter, then commit the requested option from the loaded list.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const SEARCH_ON_SUBMIT_HTML = `
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

function enterKeyDowns(cdpEvents: { method: string; params: unknown }[]): number {
  return cdpEvents.filter((e) => {
    const p = e.params as { type?: string; key?: string } | undefined;
    return e.method === "Input.dispatchKeyEvent" && p?.type === "keyDown" && p.key === "Enter";
  }).length;
}

describe("flow-runner/tryPromptSelectorPrimitive search-on-submit (real DOM)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends Enter when the post-fill list is only a placeholder, then commits the requested option", async () => {
    const stagehandAct = vi.fn();
    const { page, target, window, cdpEvents } = buildPromptWidgetHarness({
      html: SEARCH_ON_SUBMIT_HTML,
      popupByWidgetId: {
        "country-widget": { options: OPTIONS, searchOnSubmit: true },
      },
    });
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
    expect(enterKeyDowns(cdpEvents)).toBe(1);
    const committed = window.document.querySelector(
      "[data-automation-id='promptSelectionLabel']"
    )?.textContent;
    expect(committed).toBe("Sweden");
  });

  it("still sends Enter when the list shows non-matching chips, then commits the requested option", async () => {
    const stagehandAct = vi.fn();
    const { page, target, window, cdpEvents } = buildPromptWidgetHarness({
      html: SEARCH_ON_SUBMIT_HTML,
      popupByWidgetId: {
        "country-widget": { options: OPTIONS, searchOnSubmit: true },
      },
    });
    let chipsInjected = 0;
    type Loc = { first: () => { fill?: (v: string) => Promise<void> } };
    const withChips =
      (original: (s: string) => unknown) =>
      (selector: string): unknown => {
        const loc = original(selector) as Loc;
        return {
          ...loc,
          first: () => {
            const el = loc.first();
            const fill = el.fill?.bind(el);
            if (!fill) return el;
            return {
              ...el,
              fill: async (value: string): Promise<void> => {
                await fill(value);
                const list = window.document.querySelector(
                  "[data-test-popup-for] [role='listbox']"
                );
                const chip = window.document.createElement("li");
                chip.setAttribute("role", "option");
                chip.textContent = "Finland";
                list?.appendChild(chip);
                if (list) chipsInjected += 1;
              },
            };
          },
        };
      };
    const pageLoc = page as unknown as { locator: (s: string) => unknown };
    pageLoc.locator = withChips(pageLoc.locator);
    const targetLoc = target as unknown as { locator: (s: string) => unknown };
    targetLoc.locator = withChips(targetLoc.locator);
    const merged = {
      ...baseParams(page as unknown as Page, stagehandAct, ""),
      frameTarget: target,
      step: "for 'Country of residence' select 'Sweden'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(chipsInjected).toBeGreaterThan(0);
    expect(enterKeyDowns(cdpEvents)).toBe(1);
    const committed = window.document.querySelector(
      "[data-automation-id='promptSelectionLabel']"
    )?.textContent;
    expect(committed).toBe("Sweden");
  });

  it.each([
    ["exact label", ["Norway", "Sweden", "Denmark"], "Sweden", "Sweden"],
    ["suffix label", ["Norway", "Sweden (SE)", "Denmark"], "Sweden", "Sweden (SE)"],
    ["prefix label", ["Norway", "Kingdom of Sweden", "Denmark"], "Sweden", "Kingdom of Sweden"],
  ])(
    "sends no Enter for a filter-as-you-type typeahead (%s)",
    async (_name, options, requested, expectedCommit) => {
      const stagehandAct = vi.fn();
      const { page, target, window, cdpEvents } = buildPromptWidgetHarness({
        html: SEARCH_ON_SUBMIT_HTML,
        popupByWidgetId: {
          "country-widget": { options, searchable: true },
        },
      });
      const merged = {
        ...baseParams(page as unknown as Page, stagehandAct, ""),
        frameTarget: target,
        step: `for 'Country of residence' select '${requested}'`,
      };

      const result = await executeStepWithHealing(
        merged as unknown as Parameters<typeof executeStepWithHealing>[0]
      ).catch(() => "failed");

      expect(enterKeyDowns(cdpEvents)).toBe(0);
      if (expectedCommit !== requested) return;
      expect(result).toBe("completed");
      const committed = window.document.querySelector(
        "[data-automation-id='promptSelectionLabel']"
      )?.textContent;
      expect(committed).toBe(expectedCommit);
    }
  );
});
