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
 * Regression coverage for `enumerateOptionsExpr`'s label resolution: a widget
 * whose rendered `role="option"` elements match the reported evidence exactly
 * (`<div class="...-option" data-value="" role="option">`, no own text, no
 * `data-value`) must still enumerate a non-empty candidate label — read from a
 * descendant node or `aria-labelledby` — so both the deterministic matcher and
 * the LLM judge's candidate list see the real option text, not `""`.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const ARIA_BUTTON_HTML = `
<div>
  <div role="group" aria-labelledby="dept-section">
    <span id="dept-section">Team</span>
    <label for="deptType"><span>Department</span></label>
    <button id="deptType" aria-haspopup="listbox" type="button"
            aria-invalid="true" aria-label="Department Required"></button>
  </div>
</div>`;

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

describe("flow-runner/enumerateOptionsExpr (empty own text/data-value option label)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the deterministic exact-text match for two options whose own text/data-value are both empty (child-node label + aria-labelledby label)", async () => {
    const stagehandAct = vi.fn();
    const { page, target } = buildPromptWidgetHarness({
      html: ARIA_BUTTON_HTML,
      popupByWidgetId: {
        deptType: {
          options: [
            { label: "Engineering", labelVia: "child-node" },
            { label: "Marketing", labelVia: "aria-labelledby" },
          ],
          portaled: true,
        },
      },
    });
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      frameTarget: target,
      step: "for 'Department' select 'Marketing'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    // The deterministic matcher found the resolved label directly — no LLM
    // fallback and no cascade fallthrough — proving enumerateOptionsExpr
    // read a real label off the empty-own-text/data-value option.
    expect(result).toBe("completed");
    expect(judgeSelectOptionWithLLM).not.toHaveBeenCalled();
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("LLM found no matching option")
    );
  });

  it("passes the resolved non-empty labels (not empty strings) to judgeSelectOptionWithLLM when the requested text only near-matches", async () => {
    vi.mocked(judgeSelectOptionWithLLM).mockResolvedValue({
      selectIndex: 0,
      optionIndex: 1,
      reason: "closest match to the requested near-text",
    });
    const stagehandAct = vi.fn();
    const { page, target } = buildPromptWidgetHarness({
      html: ARIA_BUTTON_HTML,
      popupByWidgetId: {
        deptType: {
          options: [
            { label: "Engineering", labelVia: "child-node" },
            { label: "Marketing", labelVia: "aria-labelledby" },
          ],
          portaled: true,
        },
      },
    });
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      // Not an exact match to either resolved label, forcing the LLM fallback.
      anthropic: {} as never,
      frameTarget: target,
      step: "for 'Department' select 'Marketing Team'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(judgeSelectOptionWithLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          candidates: [
            expect.objectContaining({
              options: ["Engineering", "Marketing"],
            }),
          ],
        }),
      })
    );
    const candidateOptions =
      vi.mocked(judgeSelectOptionWithLLM).mock.calls[0]?.[0].input.candidates[0]?.options;
    expect(candidateOptions).not.toContain("");
  });
});
