import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

const SEARCH_MARK = "data-bcl-prompt-opt-idx-search";
const OPTION_MARK = "data-bcl-prompt-opt-idx";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const HTML = `
<form>
  <div>
    <label for="a--input">Departure city</label>
    <div id="a" data-uxi-widget-type="multiselect">
      <div data-automation-id="selectedItem" role="option" id="chip-a">Lisbon</div>
      <input id="a--input" data-uxi-widget-type="selectinput" type="text" value="" />
    </div>
  </div>
  <div>
    <label for="b--input">Arrival city</label>
    <div id="b" data-uxi-widget-type="multiselect">
      <input id="b--input" data-uxi-widget-type="selectinput" type="text" value="" />
    </div>
  </div>
</form>`;

describe("flow-runner/tryPromptSelectorPrimitive enumerate widget isolation (document scope)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks only the target widget's own input and never another widget's chip", async () => {
    const stagehand = {
      act: vi.fn(),
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand;
    const { page, target, window } = buildPromptWidgetHarness({
      html: HTML,
      popupByWidgetId: { b: { options: ["Porto"], portaled: true } },
    });

    await executeStepWithHealing({
      stagehand,
      page: page as unknown as Page,
      frameTarget: target,
      step: "for 'Arrival city' select 'Porto'",
      optional: false,
      upload: false,
      submitStep: false,
      stepIndex: 1,
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
      trajectory: [],
    } as never);

    const doc = window.document;
    expect(doc.getElementById("a--input")?.hasAttribute(SEARCH_MARK)).toBe(false);
    expect(doc.getElementById("chip-a")?.hasAttribute(OPTION_MARK)).toBe(false);
  });

  it("waits for a late aria-controls link rather than reading document-wide chips", async () => {
    const stagehand = {
      act: vi.fn(),
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand;
    const { page, target, window } = buildPromptWidgetHarness({
      html: HTML,
      popupByWidgetId: {
        b: { options: ["Porto"], portaled: true, linkAfterOpen: true, linkDelayMs: 300 },
      },
    });

    await executeStepWithHealing({
      stagehand,
      page: page as unknown as Page,
      frameTarget: target,
      step: "for 'Arrival city' select 'Porto'",
      optional: false,
      upload: false,
      submitStep: false,
      stepIndex: 1,
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
      trajectory: [],
    } as never);

    const doc = window.document;
    expect(doc.getElementById("chip-a")?.hasAttribute(OPTION_MARK)).toBe(false);
    expect(doc.getElementById("a--input")?.hasAttribute(SEARCH_MARK)).toBe(false);
  });
});
