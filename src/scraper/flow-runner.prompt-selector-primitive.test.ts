import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

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
});
