import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

/**
 * Guards the Enter-submit fallback: a filter-as-you-type widget whose first
 * post-fill read already names the option must be committed without ever
 * receiving a trusted Enter keyDown.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const SEARCHABLE_WIDGET_HTML = `
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

describe("flow-runner/prompt-selector filter-as-you-type widget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("commits the option without dispatching an Enter keyDown", async () => {
    const stagehandAct = vi.fn();
    const stagehand = {
      act: stagehandAct,
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand;
    const { page, target, fills, cdpEvents } = buildPromptWidgetHarness({
      html: SEARCHABLE_WIDGET_HTML,
      popupByWidgetId: {
        "src-widget": { options: ["United States", "United Kingdom", "Canada"], searchable: true },
      },
    });
    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];

    const result = await executeStepWithHealing({
      stagehand,
      page: page as unknown as Page,
      frameTarget: target,
      step: "for 'How Did You Hear About Us?' select 'Canada'",
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
      trajectory,
    } as never);

    expect(result).toBe("completed");
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(fills.length).toBeGreaterThanOrEqual(1);
    expect(trajectory).toEqual([{ stepIndex: 3, verifiedBy: "dom", targetId: "src-widget" }]);

    const enterKeyDowns = cdpEvents.filter((e) => {
      const p = e.params as { type?: string; key?: string } | undefined;
      return e.method === "Input.dispatchKeyEvent" && p?.type === "keyDown" && p.key === "Enter";
    });
    expect(enterKeyDowns).toEqual([]);
  });

  it("sends zero Enter keyDowns when the rendered label has a prefix or suffix", async () => {
    const stagehandAct = vi.fn();
    const stagehand = {
      act: stagehandAct,
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand;
    const { page, target, fills, cdpEvents } = buildPromptWidgetHarness({
      html: SEARCHABLE_WIDGET_HTML,
      popupByWidgetId: {
        "src-widget": {
          options: ["Republic of Panama (PA)", "Canada (North America)", "Mexico"],
          searchable: true,
        },
      },
    });
    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];

    await executeStepWithHealing({
      stagehand,
      page: page as unknown as Page,
      frameTarget: target,
      step: "for 'How Did You Hear About Us?' select 'Canada'",
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
      trajectory,
    } as never).catch(() => undefined);

    expect(fills.length).toBeGreaterThanOrEqual(1);

    const enterKeyDowns = cdpEvents.filter((e) => {
      const p = e.params as { type?: string; key?: string } | undefined;
      return e.method === "Input.dispatchKeyEvent" && p?.type === "keyDown" && p.key === "Enter";
    });
    expect(enterKeyDowns).toEqual([]);
  });

  it("commits an option that differs from the request only by case without an Enter keyDown", async () => {
    const stagehandAct = vi.fn();
    const stagehand = {
      act: stagehandAct,
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand;
    const { page, target, fills, cdpEvents } = buildPromptWidgetHarness({
      html: SEARCHABLE_WIDGET_HTML,
      popupByWidgetId: {
        "src-widget": { options: ["United States", "United Kingdom", "CANADA"], searchable: true },
      },
    });
    const trajectory: { stepIndex: number; verifiedBy: string; targetId?: string }[] = [];

    const result = await executeStepWithHealing({
      stagehand,
      page: page as unknown as Page,
      frameTarget: target,
      step: "for 'How Did You Hear About Us?' select 'canada'",
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
      trajectory,
    } as never);

    expect(result).toBe("completed");
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(fills.length).toBeGreaterThanOrEqual(1);
    expect(trajectory).toEqual([{ stepIndex: 3, verifiedBy: "dom", targetId: "src-widget" }]);

    const enterKeyDowns = cdpEvents.filter((e) => {
      const p = e.params as { type?: string; key?: string } | undefined;
      return e.method === "Input.dispatchKeyEvent" && p?.type === "keyDown" && p.key === "Enter";
    });
    expect(enterKeyDowns).toEqual([]);
  });
});
