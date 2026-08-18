import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

/**
 * Dispatch/disambiguation contract for the prompt-selector primitive, exercised
 * through `executeStepWithHealing` against a REAL happy-dom document (see
 * `prompt-widget-dom-harness.test-helper`) rather than substring-matched fake
 * `evaluate` results. Covers what the primitive-mechanics test does not: the
 * trajectory entry the caller records, conservative widget disambiguation on a
 * multi-widget page, and the ordering guarantee that a genuine native
 * `<select>` is claimed by the select primitive before prompt-selector runs.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** Two labelled widget-kit widgets on one page, both unfilled. */
const TWO_WIDGET_HTML = `
<div data-automation-id="applyFlowMyInfoPage">
  <div role="group" aria-labelledby="src-section">
    <span id="src-section">Contact</span>
    <div data-automation-id="formField-source">
      <label for="source--source"><span>How Did You Hear About Us?</span></label>
      <div id="src-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="source--source" data-uxi-widget-type="selectinput" type="text"
               aria-required="true" aria-invalid="true" value="" />
      </div>
    </div>
  </div>
  <div role="group" aria-labelledby="phone-section">
    <span id="phone-section">Phone</span>
    <div data-automation-id="formField-phoneType">
      <label for="phone--phoneType"><span>Phone Device Type</span></label>
      <div id="phone-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="phone--phoneType" data-uxi-widget-type="selectinput" type="text"
               aria-required="true" aria-invalid="true" value="" />
      </div>
    </div>
  </div>
</div>`;

/** A native <select> and NO prompt-widget structure. */
const SELECT_ONLY_HTML = `
<div>
  <label for="phoneType">Phone Device Type</label>
  <select id="phoneType" name="phoneType" aria-required="true">
    <option value="">Select One</option>
    <option value="home">Home</option>
    <option value="mobile">Mobile</option>
    <option value="work">Work</option>
  </select>
</div>`;

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

describe("flow-runner/tryPromptSelectorPrimitive dispatch & disambiguation (real DOM)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pushes a dom-verified trajectory entry with the resolved widget id and never reaches the cascade", async () => {
    const stagehandAct = vi.fn();
    const stagehandObserve = vi.fn().mockResolvedValue([]);
    const stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;
    const { page, target } = buildPromptWidgetHarness({
      html: TWO_WIDGET_HTML,
      popupByWidgetId: {
        "phone-widget": { options: ["Home", "Mobile", "Work"] },
        "src-widget": { options: ["Job Board", "Referral"] },
      },
    });
    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];
    const params = baseParams(
      page as unknown as Page,
      stagehand,
      "for 'Phone Device Type' select 'Mobile'",
      target
    );

    const result = await executeStepWithHealing({ ...params, trajectory } as never);

    expect(result).toBe("completed");
    // The uniquely-labelled 'phone-widget' was chosen, not the source widget.
    expect(trajectory).toEqual([{ stepIndex: 3, verifiedBy: "dom", targetId: "phone-widget" }]);
    expect(stagehandObserve).not.toHaveBeenCalled();
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("falls through (does not guess) when an unlabelled step is ambiguous across multiple unfilled widgets", async () => {
    const stagehandAct = vi.fn();
    const stagehand = {
      act: stagehandAct,
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand;
    const { page, target } = buildPromptWidgetHarness({
      html: TWO_WIDGET_HTML,
      popupByWidgetId: {
        "phone-widget": { options: ["Home", "Mobile"] },
        "src-widget": { options: ["Job Board", "Referral"] },
      },
    });
    // No 'for <label>' — just "select 'Mobile'": two unfilled widgets, so the
    // primitive must NOT guess which one the step means.
    const params = baseParams(page as unknown as Page, stagehand, "select 'Mobile'", target);

    await executeStepWithHealing(params as never).catch(() => undefined);

    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("no unambiguous widget match")
    );
  });

  it("does not shadow the select primitive: a genuine <select> resolves via the select primitive, not prompt-selector", async () => {
    const stagehandAct = vi.fn();
    const stagehand = {
      act: stagehandAct,
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand;
    const { page, target } = buildPromptWidgetHarness({
      html: SELECT_ONLY_HTML,
      popupByWidgetId: {},
    });
    const params = baseParams(
      page as unknown as Page,
      stagehand,
      "for 'Phone Device Type' select 'Mobile'",
      target
    );

    const result = await executeStepWithHealing(params as never);

    expect(result).toBe("completed");
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by select primitive")
    );
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });
});
