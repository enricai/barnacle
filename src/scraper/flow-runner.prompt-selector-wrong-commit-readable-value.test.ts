import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing, verifyPromptSelectorCommitted } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const WIDGET_HTML = `
<div role="group" aria-labelledby="major-section">
  <span id="major-section">Major</span>
  <div id="major-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
    <div data-automation-id="promptSelectionLabel"></div>
    <input id="major-input" data-uxi-widget-type="selectinput" type="text" aria-invalid="true" value="" />
  </div>
</div>`;

const OPTIONS = ["Chemistry", "Geology", "Physics"];

async function run(
  step: string,
  popup: Parameters<typeof buildPromptWidgetHarness>[0]["popupByWidgetId"][string]
): Promise<{
  result: unknown;
  harness: ReturnType<typeof buildPromptWidgetHarness>;
  trajectory: unknown[];
}> {
  const harness = buildPromptWidgetHarness({
    html: WIDGET_HTML,
    popupByWidgetId: { "major-widget": popup },
  });
  const stagehand = {
    act: vi.fn(),
    observe: vi.fn().mockResolvedValue([]),
  } as unknown as Stagehand;
  const trajectory: unknown[] = [];
  const result = await executeStepWithHealing({
    stagehand,
    page: harness.page as Page,
    frameTarget: harness.target,
    step,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex: 2,
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
  } as never).catch(() => "threw");
  return { result, harness, trajectory };
}

describe("prompt-selector read-back compares the widget's readable value to the request", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not credit a click whose widget value names a different option", async () => {
    const { trajectory } = await run(
      "In the 'Major' prompt selector, select the option 'Geology'",
      {
        options: OPTIONS,
        commitsInstead: "Chemistry",
      }
    );
    expect(trajectory).toEqual([]);
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('committed "chemistry" instead of "Geology"')
    );
  });

  it("credits the same step when the widget value names the requested option", async () => {
    const { trajectory } = await run(
      "In the 'Major' prompt selector, select the option 'Geology'",
      {
        options: OPTIONS,
      }
    );
    expect(trajectory).toEqual([{ stepIndex: 2, verifiedBy: "dom", targetId: "major-widget" }]);
  });

  it("dismisses a popup left open after a wrong commit too", async () => {
    const { harness, trajectory } = await run(
      "In the 'Major' prompt selector, select the option 'Geology'",
      {
        options: OPTIONS,
        commitsInstead: "Chemistry",
        keepPopupMounted: true,
        closesOnEscape: true,
      }
    );
    expect(trajectory).toEqual([]);
    expect(harness.window.document.querySelector("[data-test-popup-for]")).toBeNull();
  });

  it("dismisses a popup left open after a verified commit", async () => {
    const { harness, trajectory } = await run(
      "In the 'Major' prompt selector, select the option 'Geology'",
      { options: OPTIONS, keepPopupMounted: true, closesOnEscape: true }
    );
    expect(trajectory).toHaveLength(1);
    expect(harness.window.document.querySelector("[data-test-popup-for]")).toBeNull();
    expect(
      harness.cdpEvents.filter(
        (e) => (e.params as { type?: string; key?: string }).key === "Escape"
      ).length
    ).toBeGreaterThan(0);
  });
});

describe("verifyPromptSelectorCommitted with a requested option", () => {
  const html = (value: string): string => `
<div id="w" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
  <div data-automation-id="promptSelectionLabel">${value}</div>
  <input id="inp" data-uxi-widget-type="selectinput" type="text" />
</div>`;

  it("rejects a widget holding a different option", async () => {
    const { target } = buildPromptWidgetHarness({ html: html("Advertising"), popupByWidgetId: {} });
    const got = await verifyPromptSelectorCommitted(target, "xpath=//*[@id='w']", "Nursing");
    expect(got).toEqual({ isPromptWidget: true, committed: false });
  });

  it("accepts a widget holding the requested option", async () => {
    const { target } = buildPromptWidgetHarness({ html: html("Nursing"), popupByWidgetId: {} });
    const got = await verifyPromptSelectorCommitted(target, "xpath=//*[@id='w']", "Nursing");
    expect(got).toEqual({ isPromptWidget: true, committed: true });
  });

  it("prefers the announced value over a stale label", async () => {
    const announced = `${html("Nursing")}<div id="desc">1 item selected, Advertising</div>`;
    const withDesc = announced.replace('id="w"', 'id="w" aria-describedby="desc"');
    const { target } = buildPromptWidgetHarness({ html: withDesc, popupByWidgetId: {} });
    const got = await verifyPromptSelectorCommitted(target, "xpath=//*[@id='w']", "Nursing");
    expect(got?.committed).toBe(false);
  });

  it("counts any readable value as committed when no option is requested", async () => {
    const { target } = buildPromptWidgetHarness({ html: html("Advertising"), popupByWidgetId: {} });
    const got = await verifyPromptSelectorCommitted(target, "xpath=//*[@id='w']");
    expect(got?.committed).toBe(true);
  });
});
