import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { judgeSelectOptionWithLLM } from "@/lib/llm/judges/select-option";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/select-option", () => ({
  judgeSelectOptionWithLLM: vi.fn(),
}));

/**
 * Regression coverage for the prompt-selector primitive: a native-control-less
 * popup-dropdown widget (a combobox that opens a listbox popup and renders no
 * `<select>`/`<input>` the focused probe resolves) previously left an
 * application wizard walled on a required field.
 *
 * These tests run the primitive's REAL `evaluate` expression strings against a
 * live happy-dom document built from genuine widget markup (see
 * `prompt-widget-dom-harness.test-helper`), so they prove the cross-vendor
 * union selectors and the open→select→verify flow work against real DOM — not
 * that the production code happens to contain a given vendor's attribute names.
 * Two widget shapes are covered: a widget-kit shape whose ARIA is sparse (value
 * in a selection-label node, no `role=combobox`), and a near-standard
 * `<button aria-haspopup="listbox">` shape.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function actResult(overrides: Partial<ActResult> = {}): ActResult {
  return {
    success: true,
    message: "clicked",
    actionDescription: "clicked",
    actions: [],
    ...overrides,
  };
}

/**
 * A widget-kit shape (the sparse-ARIA case): the trigger is an
 * `<input data-uxi-widget-type="selectinput" aria-required aria-invalid>` inside
 * a `data-uxi-widget-type="multiselect"` container, current value in a
 * `promptSelectionLabel` node, wrapped in a labelled `role=group` — no
 * `role=combobox`, no `aria-activedescendant`.
 */
const WIDGET_KIT_HTML = `
<div data-automation-id="applyFlowMyInfoPage">
  <div role="group" aria-labelledby="source-section">
    <span id="source-section">Contact</span>
    <div data-automation-id="formField-source">
      <label for="source--source"><span>How Did You Hear About Us?</span></label>
      <div id="src-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="source--source" data-uxi-widget-type="selectinput" type="text"
               placeholder="Search" aria-required="true" aria-invalid="true" value="" />
      </div>
    </div>
  </div>
</div>`;

/**
 * A near-standard shape (the ARIA case, with ZERO widget-kit attributes on the
 * value path): the trigger is a `<button aria-haspopup="listbox">`, value in the
 * button text/`aria-label`, unfilled marked by `aria-invalid`.
 */
const ARIA_BUTTON_HTML = `
<div>
  <div role="group" aria-labelledby="phone-section">
    <span id="phone-section">Phone</span>
    <label for="phoneType"><span>Phone Device Type</span></label>
    <button id="phoneType" aria-haspopup="listbox" type="button"
            aria-invalid="true" aria-label="Phone Device Type Required"></button>
  </div>
</div>`;

/**
 * An unfilled button whose ONLY content is a decorative required-marker `<abbr>`
 * (no `aria-invalid`, no value). "Unfilled" must be decided by the value read,
 * NOT by an invalid marker — so if BUTTON_VALUE_EXPR absorbed the "*" the widget
 * would read as filled and be skipped. Exercises FIX E via candidate detection.
 */
const DECORATIVE_BUTTON_HTML = `
<div>
  <div role="group" aria-labelledby="phone-section">
    <span id="phone-section">Phone</span>
    <label for="phoneType"><span>Phone Device Type</span></label>
    <button id="phoneType" aria-haspopup="listbox" type="button"><abbr>*</abbr></button>
  </div>
</div>`;

/**
 * The multiselect-typeahead/chip variant of the widget-kit shape (transcribed
 * from the reported evidence markup): the trigger `<input>` is nested a level
 * DEEPER than {@link WIDGET_KIT_HTML} — inside its own
 * `data-automation-id="multiselectInputContainer"` wrapper, itself inside the
 * `multiSelectContainer` — and the widget's value reads via a SEPARATE
 * `promptAriaInstruction` counter node ("0 items selected") in addition to the
 * (empty) `promptSelectionLabel`. Real widget-kit chip widgets bind their
 * open/filter handler on this nested input itself, not on the outer
 * container, unlike the flatter single-value shape.
 */
const MULTISELECT_TYPEAHEAD_CHIP_HTML = `
<div data-automation-id="applyFlowMyInfoPage">
  <div role="group" aria-labelledby="source-section">
    <span id="source-section">Contact</span>
    <div data-automation-id="formField-source">
      <label for="source--source"><span>How Did You Hear About Us?</span></label>
      <div id="src-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
        <div data-automation-id="multiselectInputContainer">
          <input id="source--source" data-uxi-widget-type="selectinput" type="text"
                 placeholder="Search" aria-required="true" aria-invalid="true" value="" />
        </div>
        <div data-automation-id="promptSelectionLabel"></div>
        <div aria-live="polite" data-automation-id="promptAriaInstruction">0 items selected</div>
      </div>
    </div>
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

describe("flow-runner/tryPromptSelectorPrimitive (real DOM)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a sparse-ARIA widget-kit widget: opens popup, selects, verifies via the value union", async () => {
    const stagehandAct = vi.fn();
    const { page, target, clicks } = buildPromptWidgetHarness({
      html: WIDGET_KIT_HTML,
      popupByWidgetId: { "src-widget": { options: ["Job Board", "Referral", "LinkedIn"] } },
    });
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    // executeStepWithHealing selects the frame target internally; inject our
    // real-DOM target so the primitive's evaluate strings run against it.
    const merged = {
      ...params,
      frameTarget: target,
      step: "for 'How Did You Hear About Us?' select 'Referral'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(stagehandAct).not.toHaveBeenCalled();
    // At least a trigger click and an option click happened.
    expect(clicks.length).toBeGreaterThanOrEqual(2);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("resolves a near-standard button[aria-haspopup=listbox] widget with NO widget-kit value attributes", async () => {
    const stagehandAct = vi.fn();
    const { page, target } = buildPromptWidgetHarness({
      html: ARIA_BUTTON_HTML,
      // Portaled popup (aria-controls to a body-level listbox) — the standard
      // MUI/Radix/react-select placement, and the case that proves the value
      // union reads the button's OWN text, not the portaled option text.
      popupByWidgetId: { phoneType: { options: ["Home", "Mobile", "Work"], portaled: true } },
    });
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      frameTarget: target,
      step: "for 'Phone Device Type' select 'Mobile'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("resolves a searchable widget: options appear only after the filter input is typed", async () => {
    const stagehandAct = vi.fn();
    const { page, target, fills } = buildPromptWidgetHarness({
      html: WIDGET_KIT_HTML,
      popupByWidgetId: {
        "src-widget": { options: ["United States", "United Kingdom", "Canada"], searchable: true },
      },
    });
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      frameTarget: target,
      step: "for 'How Did You Hear About Us?' select 'Canada'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    // The filter input WAS typed into (searchable path exercised).
    expect(fills.length).toBeGreaterThanOrEqual(1);
  });

  it("falls through to the cascade unchanged when the selection does not commit", async () => {
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    // A widget with no registered popup: the trigger click opens nothing, so no
    // option renders and the primitive falls through.
    const { page, target } = buildPromptWidgetHarness({
      html: WIDGET_KIT_HTML,
      popupByWidgetId: {},
    });
    const stagehand = {
      act: stagehandAct,
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand;
    const params = { ...baseParams(page as unknown as Page, stagehandAct, ""), stagehand };
    const merged = {
      ...params,
      frameTarget: target,
      step: "for 'How Did You Hear About Us?' select 'Referral'",
    };

    await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    ).catch(() => undefined);

    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("resolves options via a MULTI-id aria-controls (decoy status region first) — FIX C end-to-end", async () => {
    const stagehandAct = vi.fn();
    const { page, target } = buildPromptWidgetHarness({
      html: ARIA_BUTTON_HTML,
      // aria-controls = "<status-id> <listbox-id>": scope must pick the listbox.
      popupByWidgetId: {
        phoneType: { options: ["Home", "Mobile", "Work"], portaled: true, decoyRef: true },
      },
    });
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      frameTarget: target,
      step: "for 'Phone Device Type' select 'Mobile'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("resolves a FILL-shaped instruction ('Fill in the ... field with ...') against a multiselect widget", async () => {
    const stagehandAct = vi.fn();
    const { page, target, clicks } = buildPromptWidgetHarness({
      html: WIDGET_KIT_HTML,
      popupByWidgetId: {
        "src-widget": { options: ["Job Board", "Referral", "Internet/Online"] },
      },
    });
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      frameTarget: target,
      step: "Fill in the 'How Did You Hear About Us?' field with 'Internet/Online'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(clicks.length).toBeGreaterThanOrEqual(2);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("resolves a FILL-shaped instruction with an UNQUOTED field label (canonical parseFillStep phrasing)", async () => {
    const stagehandAct = vi.fn();
    const { page, target, clicks } = buildPromptWidgetHarness({
      html: WIDGET_KIT_HTML,
      popupByWidgetId: {
        "src-widget": { options: ["Job Board", "Referral", "Internet/Online"] },
      },
    });
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      frameTarget: target,
      step: "Fill in the How Did You Hear About Us? field with 'Internet/Online'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(clicks.length).toBeGreaterThanOrEqual(2);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("resolves an ANSWER-shaped instruction ('Click the ... answer for the question ...') against a Yes/No widget with NO native radio inputs", async () => {
    const stagehandAct = vi.fn();
    const { page, target, window, clicks } = buildPromptWidgetHarness({
      html: ARIA_BUTTON_HTML.replaceAll(
        "Phone Device Type",
        "Are you at least 18 years of age?"
      ).replaceAll("phoneType", "ageGate"),
      popupByWidgetId: { ageGate: { options: ["Yes", "No"], portaled: true } },
    });
    // Guard the fixture's own premise: no native radio inputs render at all.
    expect(window.document.querySelectorAll('input[type="radio"]').length).toBe(0);
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      frameTarget: target,
      step: "Click the 'Yes' answer for the question 'Are you at least 18 years of age?'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(clicks.length).toBeGreaterThanOrEqual(2);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("detects an unfilled button whose only content is a decorative <abbr>* as UNFILLED — FIX E", async () => {
    const stagehandAct = vi.fn();
    const { page, target } = buildPromptWidgetHarness({
      html: DECORATIVE_BUTTON_HTML,
      popupByWidgetId: { phoneType: { options: ["Home", "Mobile", "Work"], portaled: true } },
    });
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      frameTarget: target,
      step: "for 'Phone Device Type' select 'Mobile'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    // If BUTTON_VALUE absorbed the "*", the widget reads as filled → skipped →
    // no resolution. FIX E strips the <abbr>, so it's correctly unfilled and
    // resolved.
    expect(result).toBe("completed");
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("commits a value on the multiselect-typeahead/chip widget shape (SELECT phrasing) — trigger click lands on the nested input, not the outer container", async () => {
    const stagehandAct = vi.fn();
    const { page, target, clicks } = buildPromptWidgetHarness({
      html: MULTISELECT_TYPEAHEAD_CHIP_HTML,
      popupByWidgetId: {
        "src-widget": { options: ["Job Board", "Referral", "LinkedIn"], searchable: true },
      },
    });
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      frameTarget: target,
      step: "for 'How Did You Hear About Us?' select 'Referral'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(stagehandAct).not.toHaveBeenCalled();
    // The trigger click must resolve to the widget's nested interactive
    // control (an <input>), not the outer (non-interactive) container div —
    // a click on a bare layout wrapper is what the reported failure traced to.
    expect(clicks[0]).toContain("input");
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("commits a value on the multiselect-typeahead/chip widget shape via a COMPOUND instruction ('Open the …, then select the option … from the popup list')", async () => {
    const stagehandAct = vi.fn();
    const { page, target, window, clicks } = buildPromptWidgetHarness({
      html: MULTISELECT_TYPEAHEAD_CHIP_HTML,
      popupByWidgetId: {
        "src-widget": { options: ["Job Boards", "Referral", "LinkedIn"], searchable: true },
      },
    });
    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      frameTarget: target,
      trajectory,
      step: "Open the 'How Did You Hear About Us?' prompt selector, then select the option 'Job Boards' from the popup list.",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(stagehandAct).not.toHaveBeenCalled();
    // Resolved via the primitive's own DOM verification, not the observe cascade.
    expect(trajectory).toEqual([{ stepIndex: 3, verifiedBy: "dom", targetId: "src-widget" }]);
    // The trigger click landed on the nested filter <input>, and an option click
    // followed — the widget's committed-value node reflects the chosen option.
    expect(clicks.length).toBeGreaterThanOrEqual(2);
    expect(
      window.document.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent
    ).toBe("Job Boards");
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("single-level widget-kit widget (country/source-shaped, no cascadeByOption drillTo) commits on the FIRST option click and never invokes the drill/re-match path", async () => {
    const stagehandAct = vi.fn();
    const { page, target, clicks } = buildPromptWidgetHarness({
      html: WIDGET_KIT_HTML,
      popupByWidgetId: { "src-widget": { options: ["Job Board", "Referral", "LinkedIn"] } },
    });
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      frameTarget: target,
      step: "for 'How Did You Hear About Us?' select 'Referral'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    // Exactly the trigger click plus the one real option click — no
    // intermediate category click, i.e. exactly one option-level click.
    expect(clicks.length).toBe(2);
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("drilled the popup to a new option set")
    );
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("single-level near-standard button widget (phoneType-shaped, no cascadeByOption drillTo) commits on the FIRST option click and never invokes the drill/re-match path", async () => {
    const stagehandAct = vi.fn();
    const { page, target, clicks } = buildPromptWidgetHarness({
      html: ARIA_BUTTON_HTML,
      popupByWidgetId: { phoneType: { options: ["Home", "Mobile", "Work"], portaled: true } },
    });
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      frameTarget: target,
      step: "for 'Phone Device Type' select 'Mobile'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(clicks.length).toBe(2);
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("drilled the popup to a new option set")
    );
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("commits a value on the multiselect-typeahead/chip widget shape (FILL phrasing)", async () => {
    const stagehandAct = vi.fn();
    const { page, target } = buildPromptWidgetHarness({
      html: MULTISELECT_TYPEAHEAD_CHIP_HTML,
      popupByWidgetId: {
        "src-widget": { options: ["Job Board", "Referral", "LinkedIn"], searchable: true },
      },
    });
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      frameTarget: target,
      step: "Fill in the 'How Did You Hear About Us?' field with 'Referral'",
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("drills a category itself when the requested leaf isn't in the currently-rendered popup level", async () => {
    const CATEGORY = "Job Boards";
    const LEAF = "Internet - Job Boards/Search Engines";
    const CATEGORIES = ["Advertising", CATEGORY, "Military"];
    const LEAVES = ["Glassdoor", LEAF, "irishjobs"];

    // The container itself must carry its OWN `aria-invalid` (unlike
    // WIDGET_KIT_HTML, where only the nested filter <input> does): the
    // category click's readback needs to genuinely FAIL against the
    // container-level invalid marker, so the drill-retry loop — not a
    // readback false-positive — is what carries the leaf match.
    const DRILL_WIDGET_HTML = WIDGET_KIT_HTML.replace(
      `data-automation-id="multiSelectContainer">`,
      `data-automation-id="multiSelectContainer" aria-invalid="true">`
    );

    const stagehandAct = vi.fn();
    const { page, target, clicks, window } = buildPromptWidgetHarness({
      html: DRILL_WIDGET_HTML,
      popupByWidgetId: {
        "src-widget": {
          options: CATEGORIES.map((c) =>
            c === CATEGORY ? { label: c, drillTo: { options: LEAVES } } : c
          ),
        },
      },
    });
    // The leaf text isn't among the top-level category options, so the
    // deterministic match misses at the popup's initially-rendered level and
    // falls to the LLM judge to pick the plausible category to drill into.
    vi.mocked(judgeSelectOptionWithLLM).mockResolvedValue({
      selectIndex: 0,
      optionIndex: CATEGORIES.indexOf(CATEGORY),
      reason: "closest category for the leaf hint",
    });

    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const params = baseParams(page as unknown as Page, stagehandAct, "");
    const merged = {
      ...params,
      frameTarget: target,
      anthropic: {} as never,
      trajectory,
      // Names ONLY the leaf option — no category text — so the primitive must
      // drill through the best-guess category on its own.
      step: `for 'How Did You Hear About Us?' select '${LEAF}'`,
    };

    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    );

    expect(result).toBe("completed");
    expect(trajectory).toEqual([{ stepIndex: 3, verifiedBy: "dom", targetId: "src-widget" }]);
    // Two distinct real locator clicks: the trigger-open click, then the
    // category click, then the re-matched leaf click — the category click
    // must land BEFORE the leaf click, both real gestures recorded via
    // locator().first().click() (the harness never records a synthetic
    // click), no interleaved cascade/observe fallback.
    const optionClickIndices = clicks
      .map((sel, i) => ({ sel, i }))
      .filter(({ sel }) => sel.includes("data-bcl-prompt-opt-idx"))
      .map(({ i }) => i);
    expect(optionClickIndices.length).toBe(2);
    expect(optionClickIndices[0]).toBeLessThan(optionClickIndices[1] as number);
    expect(
      window.document.querySelector("[data-automation-id='promptSelectionLabel']")?.textContent
    ).toBe(LEAF);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("drilled the popup to a new option set")
    );
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });
});
