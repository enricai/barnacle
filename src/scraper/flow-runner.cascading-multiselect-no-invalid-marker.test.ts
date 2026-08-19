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
 * Regression for bugfix-001: the SAME two-level cascading multiselect from the
 * bugfix-002/feat-002 harnesses, but this site NEVER sets `aria-invalid` on the
 * widget at all (unset before, during, and after the drill — some sites only
 * mark invalid at final form submit). commitPromptOption's `!stillInvalid`
 * readback fallback is trivially true from the very first category click, so
 * without the requested-leaf guard the readback for the CATEGORY click alone
 * would report `ok: true` and the primitive would return early having only
 * clicked the category, never drilling to and clicking the actual leaf.
 */

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
      <div id="src-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="source--source" data-uxi-widget-type="selectinput" type="text" value="" />
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
 * Same drill-in cascade as the sibling harnesses, except the widget/input
 * never carry `aria-invalid` at all — `commitLeaf` only writes the value
 * label, never touches an invalid marker, modeling a site that defers
 * validation to final submit.
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

describe("flow-runner/tryPromptSelectorPrimitive category->leaf drill on a widget with no aria-invalid marker (real DOM)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not treat the category click's readback as a committed leaf when the site never sets aria-invalid", async () => {
    const stagehandAct = vi.fn();
    const stagehandObserve = vi.fn().mockResolvedValue([]);
    const stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;
    const { page, target, clicks } = buildCascadeHarness();

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
      expect.stringContaining("drilled the popup to a new option set")
    );
    expect(trajectory).toEqual([{ stepIndex: 20, verifiedBy: "dom", targetId: "src-widget" }]);

    // The committed value must be the LEAF, never the category the readback
    // could have falsely reported as "committed" before the fix.
    const widget = (target as unknown as { evaluate: (e: string) => Promise<unknown> }).evaluate;
    const finalState = (await widget(
      `((() => { const w = document.getElementById("src-widget"); return { text: w.querySelector("[data-automation-id='promptSelectionLabel']").textContent }; })())`
    )) as { text: string };
    expect(finalState.text).toBe(LEAF);
    expect(finalState.text).not.toBe(CATEGORY);

    // Both the category and leaf option clicks landed — the drill actually
    // ran instead of exiting early after the category click alone.
    const leafOptionClicks = clicks.filter((sel) => sel.includes(PROMPT_OPTION_MARK_ATTR));
    expect(leafOptionClicks.length).toBeGreaterThanOrEqual(2);

    expect(stagehandAct).not.toHaveBeenCalled();
    expect(stagehandObserve).not.toHaveBeenCalled();
  });
});
