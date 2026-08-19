import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { judgeSelectOptionWithLLM } from "@/lib/llm/judges/select-option";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/select-option", () => ({
  judgeSelectOptionWithLLM: vi.fn(),
}));

/**
 * Regression coverage for the doc's exact two-level cascading multiselect
 * (docs/recon-cascading-multiselect-leaf-not-committed.md: "How Did You Hear
 * About Us?" — open -> categories -> click 'Job Boards' -> popup swaps to
 * that category's leaves, still uncommitted -> click the leaf -> commits),
 * built entirely on the shared `buildPromptWidgetHarness`'s `drillTo` support
 * (bugfix-001) rather than a bespoke fixture, so this suite runs the SAME
 * production `evaluate` expression strings and real locator().click() gesture
 * gating as every other prompt-selector test.
 *
 * Covers both authored shapes: the two-step case (feat-001 — category and
 * leaf named as separate flow steps) and the single-step case (feat-002 —
 * only the leaf is named, so `commitPromptOption`'s bounded drill loop must
 * click the best-guess category, detect the re-render, and re-match).
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const CATEGORY = "Job Boards";
const LEAF = "Internet - Job Boards/Search Engines";
const CATEGORIES = ["Advertising", "CVS", CATEGORY, "Job Fair", "Military", "Networking"];
const LEAVES = ["Glassdoor", "IndeedEasyApply", LEAF, "irishjobs"];

// The container carries NO `aria-invalid` of its own (only the nested
// `<input>` does) — matches the doc's captured markup and bugfix-002's
// two-step regression fixture: the readback's own-widget invalid check reads
// the container, so a genuine category-level non-commit is distinguished
// from a leaf commit purely by the committed TEXT, not a container-level
// invalid flag the container never carries.
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

// The container DOES carry its own `aria-invalid` — the single-step scenario
// needs the category click's readback to genuinely FAIL (not short-circuit
// on "not invalid"), so `commitPromptOption`'s intra-call drill loop is what
// carries the leaf match, not a readback false-positive.
const SINGLE_STEP_WIDGET_HTML = WIDGET_HTML.replace(
  `data-automation-id="multiSelectContainer">`,
  `data-automation-id="multiSelectContainer" aria-invalid="true">`
);

// Same order as CATEGORIES so `judgeSelectOptionWithLLM`'s mocked
// `optionIndex` (computed against `CATEGORIES`) addresses the right rendered
// option.
const popupByWidgetId = {
  "src-widget": {
    options: CATEGORIES.map((c) =>
      c === CATEGORY ? { label: c, drillTo: { options: LEAVES } } : c
    ),
  },
};

function baseParams(page: Page, stagehand: Stagehand, step: string, frameTarget: unknown) {
  return {
    stagehand,
    page,
    frameTarget,
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

function finalWidgetState(target: {
  evaluate: (e: string) => Promise<unknown>;
}): Promise<{ text: string; invalid: string }> {
  // The container itself carries no `aria-invalid` in the two-step fixture
  // (see WIDGET_HTML) — the invalid marker the commit clears lives on the
  // nested filter `<input>` in both fixtures, so read that consistently.
  return target.evaluate(
    `((() => { const w = document.getElementById("src-widget"); return { text: w.querySelector("[data-automation-id='promptSelectionLabel']").textContent, invalid: w.querySelector("input").getAttribute("aria-invalid") }; })())`
  ) as Promise<{ text: string; invalid: string }>;
}

describe("flow-runner/tryPromptSelectorPrimitive cascading multiselect (shared DOM harness)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("two-step-authored: resolves the category then the leaf step via the primitive and commits the leaf, no cascade fallback", async () => {
    const stagehandAct = vi.fn();
    const stagehandObserve = vi.fn().mockResolvedValue([]);
    const stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;
    const { page, target } = buildPromptWidgetHarness({ html: WIDGET_HTML, popupByWidgetId });

    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];

    const categoryResult = await executeStepWithHealing({
      ...baseParams(
        page as unknown as Page,
        stagehand,
        `for 'How Did You Hear About Us?' select '${CATEGORY}'`,
        target
      ),
      stepIndex: 10,
      trajectory,
    } as never);
    expect(categoryResult).toBe("completed");

    const leafResult = await executeStepWithHealing({
      ...baseParams(
        page as unknown as Page,
        stagehand,
        `for 'How Did You Hear About Us?' select '${LEAF}'`,
        target
      ),
      stepIndex: 11,
      trajectory,
    } as never);
    expect(leafResult).toBe("completed");

    expect(trajectory).toEqual([
      { stepIndex: 10, verifiedBy: "dom", targetId: "src-widget" },
      { stepIndex: 11, verifiedBy: "dom", targetId: "src-widget" },
    ]);

    const finalState = await finalWidgetState(
      target as unknown as { evaluate: (e: string) => Promise<unknown> }
    );
    expect(finalState.text).toBe(LEAF);
    expect(finalState.invalid).toBe("false");

    expect(stagehandAct).not.toHaveBeenCalled();
    expect(stagehandObserve).not.toHaveBeenCalled();
  });

  it("single-step-authored: naming only the leaf drills through the best-guess category within one call and commits, no cascade fallback", async () => {
    const stagehandAct = vi.fn();
    const stagehandObserve = vi.fn().mockResolvedValue([]);
    const stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;
    const { page, target } = buildPromptWidgetHarness({
      html: SINGLE_STEP_WIDGET_HTML,
      popupByWidgetId,
    });

    // The leaf text isn't among the CATEGORY options, so the deterministic
    // match misses at the category level and falls to the LLM judge to pick
    // the best-guess category for the leaf hint.
    vi.mocked(judgeSelectOptionWithLLM).mockResolvedValue({
      selectIndex: 0,
      optionIndex: CATEGORIES.indexOf(CATEGORY),
      reason: "closest category for the leaf hint",
    });

    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const result = await executeStepWithHealing({
      ...baseParams(
        page as unknown as Page,
        stagehand,
        `for 'How Did You Hear About Us?' select '${LEAF}'`,
        target
      ),
      anthropic: {} as never,
      stepIndex: 20,
      trajectory,
    } as never);

    expect(result).toBe("completed");
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("drilled the popup to a new option set")
    );
    expect(trajectory).toEqual([{ stepIndex: 20, verifiedBy: "dom", targetId: "src-widget" }]);

    const finalState = await finalWidgetState(
      target as unknown as { evaluate: (e: string) => Promise<unknown> }
    );
    expect(finalState.text).toBe(LEAF);
    expect(finalState.invalid).toBe("false");

    expect(stagehandAct).not.toHaveBeenCalled();
    expect(stagehandObserve).not.toHaveBeenCalled();
  });
});
