import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StepVerificationError } from "@/scraper/errors";
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

  it("commits the requested option after node-reusing re-renders, including one right after the stable read, clicking the node whose text matches", async () => {
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
    let previousKey = "";
    let reshuffled = false;
    const originalEvaluate = target.evaluate.bind(target) as (e: unknown) => Promise<unknown>;
    (target as unknown as { evaluate: (e: unknown) => Promise<unknown> }).evaluate = async (
      expr: unknown
    ): Promise<unknown> => {
      const out = (await originalEvaluate(expr)) as { options?: { text: string }[] } | null;
      const texts = (out?.options ?? []).map((o) => o.text);
      const key = JSON.stringify(texts);
      if (texts.includes("Sweden") && key === previousKey && !reshuffled) {
        reshuffled = true;
        const reused = window.document.querySelector("[role='option']");
        const added = window.document.createElement("li");
        if (reused) reused.textContent = "Denmark";
        reused?.setAttribute("data-automation-label", "Denmark");
        added.setAttribute("role", "option");
        added.setAttribute("data-automation-id", "promptOption");
        added.setAttribute("data-automation-label", "Sweden");
        added.textContent = "Sweden";
        reused?.parentElement?.appendChild(added);
      }
      previousKey = key;
      return out;
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
    expect(reshuffled).toBe(true);
    expect(clickedTexts).toEqual(["Sweden"]);
    const committed = window.document.querySelector(
      "[data-automation-id='promptSelectionLabel']"
    )?.textContent;
    expect(committed).toBe("Sweden");
  });

  it("never clicks a node that scrollIntoView re-binds to another item, and re-resolves to the requested option", async () => {
    const stagehandAct = vi.fn();
    const { page, target, window } = buildPromptWidgetHarness({
      html: VIRTUALIZED_HTML,
      popupByWidgetId: { "country-widget": { options: OPTIONS } },
    });
    const clickedTexts: string[] = [];
    let rebound = false;
    const originalEvaluate = target.evaluate.bind(target) as (e: unknown) => Promise<unknown>;
    (target as unknown as { evaluate: (e: unknown) => Promise<unknown> }).evaluate = async (
      expr: unknown
    ): Promise<unknown> => {
      const source = String(expr);
      const selector = /querySelector\("(\[data-bcl-prompt-opt-idx=[^\]]*\])"\)/.exec(source)?.[1];
      if (!source.includes("scrollIntoView") || !selector) return originalEvaluate(expr);
      const node = window.document.querySelector(selector.replace(/\\"/g, '"'));
      if (!node) return { state: "missing" };
      if (!rebound && node.textContent?.trim() === "Sweden") {
        rebound = true;
        const other = Array.from(window.document.querySelectorAll("[role='option']")).find(
          (n) => n.textContent?.trim() === "Denmark"
        );
        for (const [n, text] of [
          [node, "Denmark"],
          [other, "Sweden"],
        ] as const) {
          if (!n) continue;
          n.textContent = text;
          n.setAttribute("data-automation-label", text);
        }
      }
      const expected = /actual !== "([^"]*)"/.exec(source)?.[1];
      const actual = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (expected !== undefined && actual !== expected) return { state: "mismatch" };
      if (expected !== undefined) clickedTexts.push(actual);
      return { state: "hit" };
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
    expect(rebound).toBe(true);
    expect(clickedTexts).not.toContain("Denmark");
    expect(clickedTexts.every((t) => t === "Sweden")).toBe(true);
  });

  it("does not credit a step whose click commits a different item than the requested option", async () => {
    const stagehandAct = vi.fn();
    const { page, target, window } = buildPromptWidgetHarness({
      html: VIRTUALIZED_HTML,
      popupByWidgetId: { "country-widget": { options: OPTIONS } },
    });
    type Loc = { click: () => Promise<void> };
    const swapOnClick =
      (original: (s: string) => unknown) =>
      (selector: string): unknown => {
        const loc = original(selector) as Loc;
        return {
          ...loc,
          click: async (): Promise<void> => {
            const node = window.document.querySelector(selector);
            if (node?.getAttribute("role") === "option" && node.textContent?.trim() === "Sweden") {
              node.textContent = "Denmark";
              node.setAttribute("data-automation-label", "Denmark");
            }
            await loc.click();
          },
        };
      };
    const pageLoc = page as unknown as { locator: (s: string) => unknown };
    pageLoc.locator = swapOnClick(pageLoc.locator);
    const targetLoc = target as unknown as { locator: (s: string) => unknown };
    targetLoc.locator = swapOnClick(targetLoc.locator);
    const merged = {
      ...baseParams(page as unknown as Page, stagehandAct, ""),
      frameTarget: target,
      step: "for 'Country of residence' select 'Sweden'",
    };

    const outcome = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    ).then(
      (r) => r,
      (e: unknown) => e
    );

    const committed = window.document.querySelector(
      "[data-automation-id='promptSelectionLabel']"
    )?.textContent;
    expect(committed).toBe("Denmark");
    expect(outcome).not.toBe("completed");
    expect(outcome).toBeInstanceOf(StepVerificationError);
  });

  it("withholds the click when a re-render lands between the centring pass and the click", async () => {
    const stagehandAct = vi.fn();
    const { page, target, window } = buildPromptWidgetHarness({
      html: VIRTUALIZED_HTML,
      popupByWidgetId: { "country-widget": { options: OPTIONS } },
    });
    let rebound = false;
    const originalEvaluate = target.evaluate.bind(target) as (e: unknown) => Promise<unknown>;
    (target as unknown as { evaluate: (e: unknown) => Promise<unknown> }).evaluate = async (
      expr: unknown
    ): Promise<unknown> => {
      const nodes = Array.from(window.document.querySelectorAll("[role='option']"));
      if (String(expr).includes("scrollIntoView") && !rebound && nodes.length > 1) {
        rebound = true;
        const texts = nodes.map((n) => n.textContent?.trim() ?? "");
        nodes.forEach((n, i) => {
          const text = texts[(i + 1) % texts.length] ?? "";
          n.textContent = text;
          n.setAttribute("data-automation-label", text);
        });
      }
      return originalEvaluate(expr);
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
    expect(rebound).toBe(true);
    expect(
      window.document.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent
    ).toBe("Sweden");
  });
});
