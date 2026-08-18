import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing, parseSelectStep } from "@/scraper/flow-runner";
import { MULTISELECT_TYPEAHEAD_EVIDENCE_HTML } from "@/scraper/multiselect-typeahead-evidence.test-helper";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

/**
 * Pins bugfix-001 (label-extraction) and bugfix-002 (view-swap gate) together
 * against the REAL nested-DOM shape captured in the incident evidence (see
 * `src/scraper/multiselect-typeahead-evidence.test-helper.ts`): an outer
 * `[data-uxi-widget-type='multiselect'][data-automation-id='multiSelectContainer']`
 * wrapping a `[data-automation-id='multiselectInputContainer']` wrapping the
 * filter `<input data-uxi-widget-type='selectinput'>`. Neither producer
 * subtask's own test file exercises this exact captured markup, and this
 * subtask's whole reason to exist is proving them TOGETHER on it.
 */

const SILENT_LOGGER = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

// The recon evidence capture is truncated mid-attribute (a cut-off <svg> path
// `d="..."`) — happy-dom's parser still resolves the elements this test cares
// about (the container, the nested input, the committed-value nodes) fine at
// EOF, and the truncation itself is part of the real captured shape.
const EVIDENCE_WIDGET_HTML = MULTISELECT_TYPEAHEAD_EVIDENCE_HTML;

const WIDGET_CONTAINER_ID = "f07b615f-d446-4820-9312-6a5af82dfc09";
const QUESTION_LABEL = "How Did You Hear About Us?";

// A leading page/step-context quote ("'My Information'") precedes the actual
// widget label — the exact shape bugfix-001 (parseSelectStep's questionLabel
// heuristic) had to stop misreading as the questionLabel.
const COMPOUND_STEP =
  "On the authenticated 'My Information' step, open the 'How Did You Hear About Us?' prompt selector, then select the option 'Job Boards' from the popup list.";

function baseParams(page: Page, stagehandAct: ReturnType<typeof vi.fn>) {
  const stagehand = {
    act: stagehandAct,
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;
  return {
    stagehand,
    page,
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
    logger: SILENT_LOGGER,
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

describe("flow-runner multiselect-typeahead commit fix (bugfix-001 + bugfix-002, real nested-container markup)", () => {
  it("parseSelectStep extracts the correct questionLabel from the compound instruction", () => {
    const parsed = parseSelectStep(COMPOUND_STEP);
    expect(parsed).toEqual({ option: "Job Boards", questionLabel: QUESTION_LABEL });
  });

  it("resolves the compound-phrased select step via the prompt-selector primitive and commits the widget's own value node, against the real captured nested-container markup", async () => {
    const stagehandAct = vi.fn();
    const { page, target, window, clicks } = buildPromptWidgetHarness({
      html: EVIDENCE_WIDGET_HTML,
      popupByWidgetId: {
        [WIDGET_CONTAINER_ID]: {
          options: ["Job Boards", "Referral", "LinkedIn"],
          searchable: true,
        },
      },
    });
    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const params = baseParams(page as unknown as Page, stagehandAct);
    const merged = {
      ...params,
      frameTarget: target,
      trajectory,
      step: COMPOUND_STEP,
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(stagehandAct).not.toHaveBeenCalled();
    // Resolved via the primitive's own DOM verification, not the act-string cascade.
    expect(trajectory).toEqual([
      { stepIndex: 3, verifiedBy: "dom", targetId: WIDGET_CONTAINER_ID },
    ]);
    // The trigger click landed on the nested filter <input>, not the outer
    // (non-interactive) multiSelectContainer/multiselectInputContainer wrappers
    // — the exact resolution the reported failure traced to.
    expect(clicks[0]).toContain("input");
    // Real DOM assertion: the widget's own committed-value node reflects the
    // selected option text.
    expect(
      window.document.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent
    ).toBe("Job Boards");
    expect(SILENT_LOGGER.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("rejects a simulated act-string/view-swap credit on the same widget shape when the popup opens but nothing commits", async () => {
    // Padding options so opening the popup alone grows `document.body.outerHTML`
    // past `VIEW_SWAP_MIN_BYTES` (default 5000) — the exact "popup opened, DOM
    // grew, nothing committed" shape the incident report describes.
    const manyOptions = Array.from(
      { length: 40 },
      (_, i) =>
        `Referral Source Option Number ${i} - a long descriptive label padding out the popup markup`
    );
    const { page, target } = buildPromptWidgetHarness({
      html: EVIDENCE_WIDGET_HTML,
      popupByWidgetId: { [WIDGET_CONTAINER_ID]: { options: manyOptions } },
    });

    const stagehandAct = vi.fn().mockImplementation(async (): Promise<ActResult> => {
      // Stagehand's act() resolves AND executes the click itself, matching
      // production: opening the popup is the ONLY DOM effect, no option is
      // ever clicked, so the widget's committed value stays empty.
      await (
        page as unknown as {
          locator: (s: string) => { first: () => { click: () => Promise<void> } };
        }
      )
        .locator(`#${WIDGET_CONTAINER_ID}`)
        .first()
        .click();
      return {
        success: true,
        message: "clicked",
        actionDescription: "clicked How Did You Hear About Us dropdown",
        actions: [
          {
            selector: `xpath=//*[@id='${WIDGET_CONTAINER_ID}']`,
            description: "How Did You Hear About Us",
            method: "click",
          },
        ],
      };
    });

    const params = baseParams(page as unknown as Page, stagehandAct);
    const merged = {
      ...params,
      frameTarget: target,
      // Not select/fill/answer-shaped, so `tryPromptSelectorPrimitive` returns
      // null without touching the DOM and this reaches the act-string cascade
      // — the exact path the report's false positive rode.
      step: "Click the 'How Did You Hear About Us?' dropdown",
    };

    await expect(
      executeStepWithHealing(merged as unknown as Parameters<typeof executeStepWithHealing>[0])
    ).rejects.toMatchObject({ name: "StepVerificationError" });

    expect(stagehandAct).toHaveBeenCalled();
  });
});
