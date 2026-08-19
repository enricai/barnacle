import type Anthropic from "@anthropic-ai/sdk";
import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { judgeSelectOptionWithLLM } from "@/lib/llm/judges/select-option";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/select-option", () => ({
  judgeSelectOptionWithLLM: vi.fn(),
}));

/**
 * feat-002: the SAME two-level cascading multiselect from the bugfix-002
 * harness, but authored as a SINGLE flow step naming only the LEAF option —
 * `tryPromptSelectorPrimitive`'s bounded category->leaf drill must click the
 * best-guess CATEGORY (via `judgeSelectOptionWithLLM`, since the leaf text
 * doesn't exist among the category options), detect the popup's re-render to
 * leaves, re-match/re-click the leaf, and commit — all within one call, no
 * cascade fallback.
 *
 * This harness is bespoke (not the shared `buildPromptWidgetHarness`, which
 * models a single flat popup) because it must model the drill-in behavior a
 * category click has on the SAME widget's popup: swap in-place to leaf
 * options rather than commit or close.
 */

const PROMPT_WIDGET_MARK_ATTR = "data-bcl-prompt-idx";
const PROMPT_OPTION_MARK_ATTR = "data-bcl-prompt-opt-idx";

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
      <div id="src-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer" aria-invalid="true">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="source--source" data-uxi-widget-type="selectinput" type="text"
               aria-required="true" aria-invalid="true" value="" />
      </div>
    </div>
  </div>
</div>`;

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/**
 * Builds a fake `Page`/`FrameTarget` over a real happy-dom document that
 * models the drill-in cascade: a trigger click on a CLOSED popup renders
 * categories; a trigger click on an ALREADY-OPEN popup TOGGLES IT CLOSED
 * (the re-render/close-on-reclick shape the report's manual walk observed
 * for a stale re-click); clicking a category option swaps the SAME popup to
 * that category's leaves without committing the widget; clicking a leaf
 * option commits the widget's value and clears its invalid marker.
 */
function buildCascadeHarness(): {
  page: unknown;
  target: FrameTarget;
  clicks: string[];
} {
  const window = new Window({ url: "https://careers.example.com/apply/job/1" });
  const document = window.document;
  document.body.innerHTML = WIDGET_HTML;
  const clicks: string[] = [];
  let rendered: "closed" | "categories" | "leaves" = "closed";

  const renderPopup = (kind: "categories" | "leaves"): void => {
    const widgetEl = document.getElementById("src-widget") as Element;
    const existing = document.querySelector("[data-test-popup]");
    existing?.remove();
    const wrap = document.createElement("div");
    wrap.setAttribute("data-test-popup", "1");
    const opts = kind === "categories" ? CATEGORIES : LEAVES;
    wrap.innerHTML = `<ul role="listbox">${opts
      .map((o) => `<li role="option" data-automation-label="${o}">${o}</li>`)
      .join("")}</ul>`;
    widgetEl.appendChild(wrap);
    rendered = kind;
  };

  const commitLeaf = (text: string): void => {
    const widgetEl = document.getElementById("src-widget") as Element;
    let valueNode = widgetEl.querySelector("[data-automation-id='promptSelectionLabel']");
    if (!valueNode) {
      valueNode = document.createElement("div");
      valueNode.setAttribute("data-automation-id", "promptSelectionLabel");
      widgetEl.insertBefore(valueNode, widgetEl.firstChild);
    }
    valueNode.textContent = text;
    widgetEl.setAttribute("aria-invalid", "false");
    for (const n of Array.from(widgetEl.querySelectorAll("[aria-invalid='true']"))) {
      n.setAttribute("aria-invalid", "false");
    }
    document.querySelector("[data-test-popup]")?.remove();
    rendered = "closed";
  };

  const runExpr = (expr: string): unknown => {
    const fn = new window.Function("document", "window", "CSS", `return (${expr});`) as (
      d: unknown,
      w: unknown,
      c: unknown
    ) => unknown;
    return fn(document, window, window.CSS);
  };

  const resolveFirst = (selector: string): Element | null => {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  };

  const locator = (selector: string) => ({
    count: async (): Promise<number> => {
      try {
        return document.querySelectorAll(selector).length;
      } catch {
        return 0;
      }
    },
    first: () => ({
      click: async (): Promise<void> => {
        clicks.push(selector);
        const el = resolveFirst(selector);
        if (!el) return;
        const inOpenPopup = el.closest("[data-test-popup]") !== null;
        if (inOpenPopup && el.getAttribute("role") === "option") {
          const text = el.getAttribute("data-automation-label") || "";
          if (rendered === "categories") {
            renderPopup("leaves");
          } else {
            commitLeaf(text);
          }
          return;
        }
        // A trigger click (widget container / its interactive descendant),
        // never inside the popup: open when closed, TOGGLE CLOSE when
        // already open (the stale re-click perturbing an already-drilled
        // popup that the report describes).
        if (rendered === "closed") {
          renderPopup("categories");
        } else {
          document.querySelector("[data-test-popup]")?.remove();
          rendered = "closed";
        }
      },
      fill: async (): Promise<void> => undefined,
      isChecked: async (): Promise<boolean> => false,
      inputValue: async (): Promise<string> => "",
    }),
  });

  const evaluate = async (expr: unknown): Promise<unknown> => runExpr(String(expr));

  const page = {
    evaluate,
    url: () => "https://careers.example.com/apply/job/1",
    title: async (): Promise<string> => "Apply",
    locator,
    waitForTimeout: async (): Promise<void> => undefined,
  };

  const target = {
    evaluate,
    locator,
    url: async (): Promise<string> => "https://careers.example.com/apply/job/1",
    title: async (): Promise<string> => "Apply",
    frame: null,
    frameSelector: null,
    declaredFrameSelector: null,
  } as unknown as FrameTarget;

  return { page, target, clicks };
}

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

describe("flow-runner/tryPromptSelectorPrimitive intra-call category->leaf drill (real DOM)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a SINGLE authored step naming only the leaf: clicks the best-guess category, detects the drill, re-matches, and commits the leaf — no cascade fallback", async () => {
    const stagehandAct = vi.fn();
    const stagehandObserve = vi.fn().mockResolvedValue([]);
    const stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;
    const { page, target, clicks } = buildCascadeHarness();

    // The leaf text isn't among the CATEGORY options, so commitPromptOption's
    // deterministic match misses at the category level and falls to the LLM
    // judge to pick the best-guess category ("Job Boards") for the leaf hint.
    vi.mocked(judgeSelectOptionWithLLM).mockResolvedValue({
      selectIndex: 0,
      optionIndex: CATEGORIES.indexOf(CATEGORY),
      reason: "closest category for the leaf hint",
    });

    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const stepParams = baseParams(
      page as unknown as Page,
      stagehand,
      `for 'How Did You Hear About Us?' select '${LEAF}'`,
      target
    );
    const stepResult = await executeStepWithHealing({
      ...stepParams,
      anthropic: {} as unknown as Anthropic,
      stepIndex: 20,
      trajectory,
    } as never);

    expect(stepResult).toBe("completed");
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("drilled the popup to a new option set")
    );
    // The single step resolved entirely via the primitive (dom-verified).
    expect(trajectory).toEqual([{ stepIndex: 20, verifiedBy: "dom", targetId: "src-widget" }]);

    // Leaf committed — readback ok / aria-invalid cleared.
    const widget = (target as unknown as { evaluate: (e: string) => Promise<unknown> }).evaluate;
    const finalState = (await widget(
      `((() => { const w = document.getElementById("src-widget"); return { text: w.querySelector("[data-automation-id='promptSelectionLabel']").textContent, invalid: w.getAttribute("aria-invalid") }; })())`
    )) as { text: string; invalid: string };
    expect(finalState.text).toBe(LEAF);
    expect(finalState.invalid).toBe("false");

    // No el.click()-fallback path executed — the cascade never ran at all.
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(stagehandObserve).not.toHaveBeenCalled();

    // A SINGLE trigger click opens the popup; both the category and leaf
    // clicks land on marked options within that same call.
    const leafOptionClicks = clicks.filter((sel) => sel.includes(PROMPT_OPTION_MARK_ATTR));
    const triggerClicks = clicks.filter(
      (sel) => sel.includes(PROMPT_WIDGET_MARK_ATTR) && !sel.includes(PROMPT_OPTION_MARK_ATTR)
    );
    expect(triggerClicks).toHaveLength(1);
    expect(leafOptionClicks.length).toBeGreaterThanOrEqual(2);
  });

  it("does not mask a genuine non-commit as a drill: clicking the category exactly, then failing to match anything among the drilled leaves, still falls through to the cascade", async () => {
    // A regression guard for the drill's own failure path, distinct from the
    // pre-existing flat-widget coverage in flow-runner.prompt-selector-primitive.test.ts
    // (lines ~162 and ~241), which already pins that a non-cascading widget's
    // single-click commit and its genuine non-commit fallthrough are both
    // unaffected by this change (both suites are green with this diff).
    const stagehandAct = vi.fn();
    const stagehandObserve = vi.fn().mockResolvedValue([]);
    const stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;
    const { page, target } = buildCascadeHarness();

    // Exact-text match at the category level clicks "Job Boards" itself
    // (not a leaf-only hint), so the drill fires (categories -> leaves) but
    // no leaf text matches "Job Boards" and there is no LLM client to pick a
    // best guess — the primitive must fall through, never treat the drilled
    // re-render as a false commit.
    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const stepParams = baseParams(
      page as unknown as Page,
      stagehand,
      `for 'How Did You Hear About Us?' select '${CATEGORY}'`,
      target
    );
    await expect(
      executeStepWithHealing({
        ...stepParams,
        stepIndex: 30,
        trajectory,
      } as never)
    ).rejects.toThrow();

    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("drilled the popup to a new option set")
    );
    expect(testLogger.info).toHaveBeenCalledWith(expect.stringContaining("no option match"));
    expect(trajectory).toEqual([]);
  });
});
