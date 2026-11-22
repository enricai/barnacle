import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/select-option", () => ({
  judgeSelectOptionWithLLM: vi.fn(),
}));

/**
 * Search-on-submit regression coverage: placeholder variants, a fill-shaped
 * step, Enter routed through a frame session, and search-as-you-type widgets
 * that must never receive Enter.
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

const SELECTOR = "[data-automation-id='promptSelectionLabel']";

async function run(
  h: ReturnType<typeof buildPromptWidgetHarness>,
  step: string,
  target: unknown = h.target
): Promise<string> {
  const merged = {
    ...baseParams(h.page as unknown as Page, vi.fn(), ""),
    frameTarget: target,
    step,
  };
  return executeStepWithHealing(
    merged as unknown as Parameters<typeof executeStepWithHealing>[0]
  ).catch(() => "failed");
}

describe("flow-runner/tryPromptSelectorPrimitive search-on-submit placeholders (real DOM)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["No Items.", "University of Texas"],
    ["No results", "University of Texas"],
  ])(
    "sends one Enter for placeholder '%s' and commits the requested label",
    async (placeholderText, label) => {
      const h = buildPromptWidgetHarness({
        html: SEARCH_ON_SUBMIT_HTML,
        popupByWidgetId: {
          "country-widget": {
            options: ["University of Texas", "University of Utah", "University of Oslo"],
            searchOnSubmit: true,
            placeholderText,
          },
        },
      });
      const result = await run(h, `for 'Country of residence' select '${label}'`);
      expect(result).toBe("completed");
      expect(enterKeyDowns(h.cdpEvents)).toBe(1);
      expect(h.window.document.querySelector(SELECTOR)?.textContent).toBe(label);
    }
  );

  it("sends one Enter when the pre-Enter list is non-empty but names nothing requested", async () => {
    const h = buildPromptWidgetHarness({
      html: SEARCH_ON_SUBMIT_HTML,
      popupByWidgetId: {
        "country-widget": {
          options: ["University of Texas", "University of Utah"],
          searchOnSubmit: true,
        },
      },
    });
    type Loc = { first: () => { fill?: (v: string) => Promise<void> } };
    const withChip =
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
                const chip = h.window.document.createElement("li");
                chip.setAttribute("role", "option");
                chip.textContent = "Recent: Example College";
                h.window.document
                  .querySelector("[data-test-popup-for] [role='listbox']")
                  ?.append(chip);
              },
            };
          },
        };
      };
    for (const o of [h.page, h.target] as unknown as { locator: (s: string) => unknown }[]) {
      o.locator = withChip(o.locator);
    }
    const result = await run(h, "for 'Country of residence' select 'University of Texas'");
    expect(result).toBe("completed");
    expect(enterKeyDowns(h.cdpEvents)).toBe(1);
    expect(h.window.document.querySelector(SELECTOR)?.textContent).toBe("University of Texas");
  });

  it("handles a fill-shaped step instruction with exactly one Enter", async () => {
    const h = buildPromptWidgetHarness({
      html: SEARCH_ON_SUBMIT_HTML,
      popupByWidgetId: {
        "country-widget": {
          options: ["University of Texas", "University of Utah"],
          searchOnSubmit: true,
          placeholderText: "No Items.",
        },
      },
    });
    const result = await run(
      h,
      "Fill in the Country of residence field with 'University of Texas'"
    );
    expect(enterKeyDowns(h.cdpEvents)).toBe(1);
    expect(result).toBe("completed");
    expect(h.window.document.querySelector(SELECTOR)?.textContent).toBe("University of Texas");
  });

  it("routes Enter through the frame CDP session, not the page", async () => {
    const h = buildPromptWidgetHarness({
      html: SEARCH_ON_SUBMIT_HTML,
      popupByWidgetId: {
        "country-widget": { options: OPTIONS, searchOnSubmit: true },
      },
    });
    const pageSend = (h.page as unknown as { sendCDP: (m: string, p?: unknown) => Promise<void> })
      .sendCDP;
    const frameEvents: { method: string; params: unknown }[] = [];
    const pageEvents: { method: string; params: unknown }[] = [];
    (h.page as unknown as { sendCDP: unknown }).sendCDP = async (
      method: string,
      params?: unknown
    ): Promise<void> => {
      pageEvents.push({ method, params });
      await pageSend(method, params);
    };
    const frameTarget = {
      ...h.target,
      frame: {
        session: {
          send: async (method: string, params?: unknown): Promise<void> => {
            frameEvents.push({ method, params });
            await pageSend(method, params);
          },
        },
      },
    };
    const result = await run(h, "for 'Country of residence' select 'Sweden'", frameTarget);
    expect(result).toBe("completed");
    expect(enterKeyDowns(frameEvents)).toBe(1);
    expect(enterKeyDowns(pageEvents)).toBe(0);
    expect(h.window.document.querySelector(SELECTOR)?.textContent).toBe("Sweden");
  });

  it.each([
    ["exact", ["Norway", "Sweden", "Denmark"], "Sweden"],
    ["case differs", ["Norway", "SWEDEN", "Denmark"], "Sweden"],
  ])("never sends Enter to a search-as-you-type widget (%s)", async (_n, options, requested) => {
    const h = buildPromptWidgetHarness({
      html: SEARCH_ON_SUBMIT_HTML,
      popupByWidgetId: { "country-widget": { options, searchable: true } },
    });
    const result = await run(h, `for 'Country of residence' select '${requested}'`);
    expect(enterKeyDowns(h.cdpEvents)).toBe(0);
    expect(result).toBe("completed");
    expect(h.window.document.querySelector(SELECTOR)?.textContent?.toLowerCase()).toBe(
      requested.toLowerCase()
    );
  });
});
