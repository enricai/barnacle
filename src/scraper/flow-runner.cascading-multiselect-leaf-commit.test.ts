import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression for bugfix-002: a two-level cascading multiselect (doc's
 * "source" / "How Did You Hear About Us?" widget — open -> pick a CATEGORY
 * -> popup swaps to that category's LEAVES -> pick a leaf to commit) authored
 * as two flow steps must resolve BOTH steps via `tryPromptSelectorPrimitive`,
 * never falling to the observe cascade's `el.click()` fallback that these
 * widgets ignore (per the primitive's own doc comment).
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
      <div id="src-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
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

describe("flow-runner/tryPromptSelectorPrimitive two-level cascading multiselect (real DOM)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves both the category and leaf steps via the primitive and commits the leaf, with no el.click() cascade fallback", async () => {
    const stagehandAct = vi.fn();
    const stagehandObserve = vi.fn().mockResolvedValue([]);
    const stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;
    const { page, target, clicks } = buildCascadeHarness();

    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];

    const step10Params = baseParams(
      page as unknown as Page,
      stagehand,
      `for 'How Did You Hear About Us?' select '${CATEGORY}'`,
      target
    );
    const step10Result = await executeStepWithHealing({
      ...step10Params,
      stepIndex: 10,
      trajectory,
    } as never);

    expect(step10Result).toBe("completed");
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );

    const step11Params = baseParams(
      page as unknown as Page,
      stagehand,
      `for 'How Did You Hear About Us?' select '${LEAF}'`,
      target
    );
    const step11Result = await executeStepWithHealing({
      ...step11Params,
      stepIndex: 11,
      trajectory,
    } as never);

    expect(step11Result).toBe("completed");
    // Both steps resolved via the primitive (dom-verified), never the cascade.
    expect(trajectory).toEqual([
      { stepIndex: 10, verifiedBy: "dom", targetId: "src-widget" },
      { stepIndex: 11, verifiedBy: "dom", targetId: "src-widget" },
    ]);

    // (b) leaf committed — readback ok / aria-invalid cleared.
    const widget = (target as unknown as { evaluate: (e: string) => Promise<unknown> }).evaluate;
    const finalState = (await widget(
      `((() => { const w = document.getElementById("src-widget"); return { text: w.querySelector("[data-automation-id='promptSelectionLabel']").textContent, invalid: w.getAttribute("aria-invalid") }; })())`
    )) as { text: string; invalid: string };
    expect(finalState.text).toBe(LEAF);
    expect(finalState.invalid).toBe("false");

    // (c) no el.click()-fallback path executed for either step — the cascade
    // never ran at all (act/observe never called).
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(stagehandObserve).not.toHaveBeenCalled();

    // The leaf step must NOT have re-clicked the trigger (the bug's blind
    // re-click that perturbed the already-open, already-drilled popup) — its
    // only click is the leaf option's own marked selector.
    const leafOptionClicks = clicks.filter((sel) => sel.includes(PROMPT_OPTION_MARK_ATTR));
    const triggerClicks = clicks.filter(
      (sel) => sel.includes(PROMPT_WIDGET_MARK_ATTR) && !sel.includes(PROMPT_OPTION_MARK_ATTR)
    );
    // Step 10 opens the popup (1 trigger click) and clicks the category
    // option; step 11, with the fix, issues NO trigger click at all.
    expect(triggerClicks).toHaveLength(1);
    expect(leafOptionClicks.length).toBeGreaterThanOrEqual(2);
  });
});
