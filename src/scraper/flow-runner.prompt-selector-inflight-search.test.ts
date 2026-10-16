import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

/**
 * A filter-as-you-type widget whose results arrive after a delay must not
 * receive Enter while the search is in flight, and a marked option node that
 * stops showing the matched option must not be clicked.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const HTML = `
<div data-automation-id="applyFlowMyInfoPage">
  <div role="group" aria-labelledby="dept-section">
    <span id="dept-section">Contact</span>
    <div data-automation-id="formField-dept">
      <label for="dept--dept"><span>Department</span></label>
      <div id="dept-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="dept--dept" data-uxi-widget-type="selectinput" type="text"
               placeholder="Search" aria-required="true" aria-invalid="true" value="" />
      </div>
    </div>
  </div>
</div>`;

const OPTIONS = ["Engineering", "Marketing", "Finance"];

function enterKeyDowns(cdpEvents: { method: string; params: unknown }[]): number {
  return cdpEvents.filter((e) => {
    const p = e.params as { type?: string; key?: string } | undefined;
    return e.method === "Input.dispatchKeyEvent" && p?.type === "keyDown" && p.key === "Enter";
  }).length;
}

function params(page: Page, target: unknown, stagehandAct: ReturnType<typeof vi.fn>) {
  return {
    stagehand: {
      act: stagehandAct,
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand,
    page,
    frameTarget: target,
    step: "for 'Department' select 'Marketing'",
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
  } as never;
}

describe("flow-runner/prompt-selector in-flight as-you-type search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("waits for delayed results and commits without pressing Enter", async () => {
    const stagehandAct = vi.fn();
    const { page, target, window, cdpEvents } = buildPromptWidgetHarness({
      html: HTML,
      popupByWidgetId: { "dept-widget": { options: OPTIONS, searchable: true } },
    });
    const realFill = target.locator as (s: string) => {
      first: () => { fill: (v: string) => Promise<void> };
    };
    let elapsed = 0;
    let rendered = "";
    const mockPage = page as unknown as {
      waitForTimeout: (ms?: number) => Promise<void>;
      locator: unknown;
    };
    const realWait = mockPage.waitForTimeout;
    mockPage.waitForTimeout = async (ms?: number): Promise<void> => {
      elapsed += ms ?? 0;
      const list = window.document.querySelector("[data-test-popup-for] [role='listbox']");
      if (rendered && list && elapsed >= 900) {
        list.innerHTML = rendered;
        rendered = "";
      }
      await realWait();
    };
    const wrap = (original: typeof realFill) => (selector: string) => {
      const loc = original(selector);
      return {
        ...loc,
        first: () => {
          const el = loc.first();
          return {
            ...el,
            fill: async (v: string): Promise<void> => {
              await el.fill(v);
              const list = window.document.querySelector("[data-test-popup-for] [role='listbox']");
              if (!list) return;
              rendered = list.innerHTML;
              list.innerHTML = "<li data-test-placeholder='true'>No Items.</li>";
              elapsed = 0;
            },
          };
        },
      };
    };
    (target as unknown as { locator: unknown }).locator = wrap(realFill);
    mockPage.locator = wrap(realFill);

    const result = await executeStepWithHealing(
      params(page as unknown as Page, target, stagehandAct)
    );

    expect(result).toBe("completed");
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(enterKeyDowns(cdpEvents)).toBe(0);
  });

  it("does not click when the marked option node no longer shows the matched option", async () => {
    const stagehandAct = vi.fn().mockResolvedValue(undefined);
    const harness = buildPromptWidgetHarness({
      html: HTML,
      popupByWidgetId: { "dept-widget": { options: OPTIONS, searchable: true } },
    });
    const { page, target, window, centres } = harness;
    const realEvaluate = target.evaluate.bind(target) as (s: string) => Promise<unknown>;
    (target as unknown as { evaluate: unknown }).evaluate = async (source: string) => {
      if (source.includes("labelOf(el)")) {
        for (const li of window.document.querySelectorAll("[role='option']")) {
          li.textContent = "Operations";
          li.setAttribute("data-automation-label", "Operations");
        }
      }
      return realEvaluate(source);
    };

    await expect(
      executeStepWithHealing(params(page as unknown as Page, target, stagehandAct))
    ).rejects.toMatchObject({ name: "StepVerificationError" });

    expect(centres.filter((c) => c.includes("-opt-idx"))).toEqual([]);
  });
});
