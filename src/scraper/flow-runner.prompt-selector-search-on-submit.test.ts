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

  it.each([
    ["No results", "No results"],
    ["No Items.", "No Items."],
    ["query echo", "Sweden - searching"],
    ["query echo (case differs)", "SWEDEN"],
  ])(
    "sends exactly one Enter and commits when the pre-Enter list is a placeholder (%s)",
    async (_name, placeholderText) => {
      const stagehandAct = vi.fn();
      const { page, target, window, cdpEvents } = buildPromptWidgetHarness({
        html: SEARCH_ON_SUBMIT_HTML,
        popupByWidgetId: {
          "country-widget": { options: OPTIONS, searchOnSubmit: true, placeholderText },
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
      expect(enterKeyDowns(cdpEvents)).toBe(1);
      expect(
        window.document.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent
      ).toBe("Sweden");
    }
  );

  it("sends Enter when the list holds only a shorter chip the request merely contains", async () => {
    const stagehandAct = vi.fn();
    const { page, target, window, cdpEvents } = buildPromptWidgetHarness({
      html: SEARCH_ON_SUBMIT_HTML,
      popupByWidgetId: {
        "country-widget": {
          options: ["Oslo", "University of Oslo", "University of Bergen"],
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
                const chip = window.document.createElement("li");
                chip.setAttribute("role", "option");
                chip.textContent = "Oslo";
                window.document
                  .querySelector("[data-test-popup-for] [role='listbox']")
                  ?.append(chip);
              },
            };
          },
        };
      };
    const pageLoc = page as unknown as { locator: (s: string) => unknown };
    pageLoc.locator = withChip(pageLoc.locator);
    const targetLoc = target as unknown as { locator: (s: string) => unknown };
    targetLoc.locator = withChip(targetLoc.locator);
    const merged = {
      ...baseParams(page as unknown as Page, stagehandAct, ""),
      frameTarget: target,
      step: "for 'Country of residence' select 'University of Oslo'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(enterKeyDowns(cdpEvents)).toBe(1);
    expect(
      window.document.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent
    ).toBe("University of Oslo");
  });

  it("sends no Enter when a search-as-you-type list shows stale rows first and settles on the requested option", async () => {
    const stagehandAct = vi.fn();
    const { page, target, window, cdpEvents } = buildPromptWidgetHarness({
      html: SEARCH_ON_SUBMIT_HTML,
      popupByWidgetId: { "country-widget": { options: OPTIONS, searchable: true } },
    });
    let restore: (() => void) | null = null;
    type Loc = { first: () => { fill?: (v: string) => Promise<void> } };
    const staleAfterFill =
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
                const nodes = Array.from(window.document.querySelectorAll("[role='option']"));
                const texts = nodes.map((n) => n.textContent ?? "");
                const setText = (
                  n: { textContent: string | null; setAttribute: (k: string, v: string) => void },
                  text: string
                ): void => {
                  n.textContent = text;
                  n.setAttribute("data-automation-label", text);
                };
                for (const n of nodes) setText(n, "Previous results");
                restore = () => {
                  nodes.forEach((n, i) => {
                    setText(n, texts[i] ?? "");
                  });
                };
              },
            };
          },
        };
      };
    const pageLoc = page as unknown as { locator: (s: string) => unknown };
    pageLoc.locator = staleAfterFill(pageLoc.locator);
    const targetLoc = target as unknown as { locator: (s: string) => unknown };
    targetLoc.locator = staleAfterFill(targetLoc.locator);
    const timed = page as unknown as { waitForTimeout: () => Promise<void> };
    const originalWait = timed.waitForTimeout.bind(page);
    let waits = 0;
    timed.waitForTimeout = async () => {
      if (restore) waits += 1;
      if (waits === 2) (restore as (() => void) | null)?.();
      await originalWait();
    };
    const merged = {
      ...baseParams(page as unknown as Page, stagehandAct, ""),
      frameTarget: target,
      step: "for 'Country of residence' select 'Sweden'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(enterKeyDowns(cdpEvents)).toBe(0);
    expect(
      window.document.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent
    ).toBe("Sweden");
  });

  it("commits after Enter for a fill-shaped step against a placeholder-only list", async () => {
    const stagehandAct = vi.fn();
    const { page, target, window, cdpEvents } = buildPromptWidgetHarness({
      html: SEARCH_ON_SUBMIT_HTML,
      popupByWidgetId: {
        "country-widget": { options: ["University of Texas", "University of Utah"], searchOnSubmit: true },
      },
    });
    const merged = {
      ...baseParams(page as unknown as Page, stagehandAct, ""),
      frameTarget: target,
      step: "Fill the Country of residence field with 'University of Texas'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(enterKeyDowns(cdpEvents)).toBe(1);
    expect(
      window.document.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent
    ).toBe("University of Texas");
  });

  it("stops at the Enter cap and commits nothing when the list never names the request", async () => {
    const stagehandAct = vi.fn().mockResolvedValue(undefined);
    const { page, target, window, cdpEvents } = buildPromptWidgetHarness({
      html: SEARCH_ON_SUBMIT_HTML,
      popupByWidgetId: {
        "country-widget": { options: ["Norway", "Denmark", "Finland"], searchOnSubmit: true },
      },
    });
    const merged = {
      ...baseParams(page as unknown as Page, stagehandAct, ""),
      frameTarget: target,
      step: "for 'Country of residence' select 'Sweden'",
    };

    await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    ).catch(() => "failed");

    expect(enterKeyDowns(cdpEvents)).toBeLessThanOrEqual(2);
    expect(enterKeyDowns(cdpEvents)).toBeGreaterThan(0);
    expect(
      window.document.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent
    ).toBe("");
  });

  it("delivers Enter through the child frame's own session when the target has one", async () => {
    const stagehandAct = vi.fn();
    const { page, target, window, cdpEvents } = buildPromptWidgetHarness({
      html: SEARCH_ON_SUBMIT_HTML,
      popupByWidgetId: { "country-widget": { options: OPTIONS, searchOnSubmit: true } },
    });
    const frameSends: { method: string; params: unknown }[] = [];
    const frameSend = async (method: string, params?: unknown): Promise<void> => {
      frameSends.push({ method, params });
      await (page as unknown as { sendCDP: (m: string, p?: unknown) => Promise<void> }).sendCDP(
        method,
        params
      );
    };
    (target as unknown as { frame: unknown }).frame = { session: { send: frameSend } };
    const pageSend = (page as unknown as { sendCDP: (m: string, p?: unknown) => Promise<void> })
      .sendCDP;
    const pageOnly: { method: string; params: unknown }[] = [];
    (page as unknown as { sendCDP: unknown }).sendCDP = async (m: string, p?: unknown) => {
      pageOnly.push({ method: m, params: p });
      return pageSend(m, p);
    };
    const merged = {
      ...baseParams(page as unknown as Page, stagehandAct, ""),
      frameTarget: target,
      step: "for 'Country of residence' select 'Sweden'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(enterKeyDowns(frameSends)).toBe(1);
    expect(enterKeyDowns(pageOnly.filter((e) => !frameSends.includes(e)))).toBe(1);
    expect(
      window.document.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent
    ).toBe("Sweden");
    expect(enterKeyDowns(cdpEvents)).toBe(1);
  });
});
