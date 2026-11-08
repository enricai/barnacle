import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/select-option", () => ({
  judgeSelectOptionWithLLM: vi.fn(),
}));

/**
 * Layered custom-select widget model (visible combobox anchor + hidden opener + covered native select).
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

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

const HTML = `
<form>
  <div>
    <label for="cc-anchor">Country Code</label>
    <div id="cc-anchor" role="combobox" tabindex="0">Select</div>
    <div id="cc-opener" aria-haspopup="listbox" aria-label="Country Code" style="display:none">Select</div>
    <select id="cc-native" aria-label="Country Code" style="display:none"><option value="">Select</option><option>Norway</option><option>Sweden</option></select>
  </div>
  <div id="decoy" role="listbox"><div role="option">Wrong Panel Option</div></div>
</form>`;

describe("flow-runner layered custom-select widget (real DOM)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("models anchor + hidden opener + native select as one widget and clicks the rendered control", async () => {
    const h = buildPromptWidgetHarness({
      html: HTML,
      popupByWidgetId: { "cc-anchor": { options: ["Norway", "Sweden"] } },
    });
    const merged = {
      ...baseParams(h.page as unknown as Page, vi.fn(), ""),
      frameTarget: h.target,
      step: "for 'Phone Country Code' select 'Norway'",
    };
    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    ).catch(() => "failed");
    expect(result).toBe("completed");
    expect(h.clicks.some((c) => c.includes("cc-opener"))).toBe(false);
    expect(h.window.document.getElementById("cc-anchor")?.textContent).toContain("Norway");
  });

  it("does not match an unrelated label", async () => {
    const h = buildPromptWidgetHarness({
      html: HTML,
      popupByWidgetId: { "cc-anchor": { options: ["Norway"] } },
    });
    const merged = {
      ...baseParams(h.page as unknown as Page, vi.fn(), ""),
      frameTarget: h.target,
      step: "for 'Favourite Colour' select 'Norway'",
    };
    await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    ).catch(() => "failed");
    expect(h.clicks.length).toBe(0);
  });

  it("scopes options to a collapsed opener's aria-controls when the rendered anchor has no popup link", async () => {
    const html = `
<form>
  <div>
    <label for="cc-anchor">Country Code</label>
    <div id="cc-anchor" role="combobox" tabindex="0">Select</div>
    <div id="cc-opener" aria-haspopup="listbox" aria-controls="cc-list" aria-label="Country Code" style="display:none">Select</div>
  </div>
  <div id="cc-list" role="listbox"><div role="option">Norway</div><div role="option">Sweden</div></div>
  <div id="decoy" role="listbox"><div role="option">Wrong Panel Option</div></div>
</form>`;
    const h = buildPromptWidgetHarness({ html, popupByWidgetId: {} });
    const merged = {
      ...baseParams(h.page as unknown as Page, vi.fn(), ""),
      frameTarget: h.target,
      step: "for 'Country Code' select 'Norway'",
    };
    await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    ).catch(() => "failed");
    expect(h.clicks.some((c) => c.includes("Wrong Panel"))).toBe(false);
    expect(h.clicks.some((c) => c.includes("cc-opener"))).toBe(false);
  });

  it("does not treat an aria-hidden or [hidden] anchor as the rendered widget", async () => {
    for (const attr of ['aria-hidden="true"', "hidden"]) {
      const html = HTML.replace('id="cc-anchor"', `${attr} id="cc-anchor"`);
      const h = buildPromptWidgetHarness({
        html,
        popupByWidgetId: { "cc-anchor": { options: ["Norway"] } },
      });
      const merged = {
        ...baseParams(h.page as unknown as Page, vi.fn(), ""),
        frameTarget: h.target,
        step: "for 'Phone Country Code' select 'Norway'",
      };
      await executeStepWithHealing(
        merged as unknown as Parameters<typeof executeStepWithHealing>[0]
      ).catch(() => "failed");
      expect(h.clicks.some((c) => c.includes("cc-anchor"))).toBe(false);
    }
  });
});

describe("flow-runner layered widget: hidden opener aria-owns an empty panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const LAYERED = `
<form>
  <div id="field-wrap">
    <label for="cc-select">Country Code</label>
    <div id="cc-opener" aria-haspopup="listbox" aria-owns="cc-empty-panel" aria-label="Country Code" style="width:0;height:0;overflow:hidden">Select</div>
    <select id="cc-select" aria-label="Country Code" style="display:none"><option value=""></option></select>
    <div id="cc-wrapper">
      <div id="cc-anchor" role="combobox" tabindex="0">Select</div>
      <div role="listbox"><div role="option">Norway</div><div role="option">Sweden</div></div>
    </div>
  </div>
  <div id="cc-empty-panel" role="listbox"><div role="option"></div></div>
</form>`;

  async function run(step: string) {
    const h = buildPromptWidgetHarness({
      html: LAYERED,
      popupByWidgetId: { "cc-anchor": { options: ["Norway", "Sweden"] } },
    });
    const merged = {
      ...baseParams(h.page as unknown as Page, vi.fn(), ""),
      frameTarget: h.target,
      step,
    };
    const r = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    ).catch(() => "failed");
    return { h, r };
  }

  it("clicks the rendered control and never the hidden opener or its empty panel", async () => {
    const { h } = await run("for 'Country Code' select 'Norway'");
    // Options come from the visible widget's own list: a click lands (on an
    // option or the rendered anchor), never on the opener or its empty panel.
    expect(h.clicks.length).toBeGreaterThan(0);
    expect(h.clicks.some((c) => c.includes("cc-opener"))).toBe(false);
    expect(h.clicks.some((c) => c.includes("cc-empty-panel"))).toBe(false);
  });

  it("resolves the paired select's label and does not enumerate duplicate widgets", async () => {
    const { h } = await run("for 'Country Code' select 'Sweden'");
    const widgetClicks = new Set(h.clicks.filter((c) => c.includes("data-bcl-prompt-idx")));
    expect(widgetClicks.size).toBeLessThanOrEqual(1);
    expect(h.clicks.some((c) => c.includes("cc-select"))).toBe(false);
  });
});

describe("flow-runner layered widget: placeholder-labelled anchor, 0x0 opener, covered rendered select", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const SHAPE = `
<form>
  <div id="field-wrap">
    <label for="cc-select">Country Code</label>
    <div id="cc-opener" aria-haspopup="listbox" aria-owns="cc-empty-panel" aria-label="Country Code" style="width:0;height:0;overflow:hidden">Select</div>
    <select id="cc-select" role="combobox" aria-controls="cc-empty-panel"><option value=""></option></select>
    <div id="cc-wrapper">
      <a id="cc-anchor" role="combobox" tabindex="0" aria-label="Select an option">Select</a>
      <div role="listbox"><div role="option">Norway</div><div role="option">Sweden</div></div>
    </div>
  </div>
  <div id="cc-empty-panel" role="listbox"><div role="option"></div></div>
</form>`;

  it("enumerates one widget, clicks the anchor, and never clicks the opener or select", async () => {
    const h = buildPromptWidgetHarness({
      html: SHAPE,
      popupByWidgetId: { "cc-anchor": { options: ["Norway", "Sweden"] } },
    });
    const merged = {
      ...baseParams(h.page as unknown as Page, vi.fn(), ""),
      frameTarget: h.target,
      step: "for 'Country Code' select 'Sweden'",
    };
    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    ).catch(() => "failed");
    void result;
    // The anchor's wrapper holds the real list: its option is clicked (the
    // wrapper list is already rendered), never the opener, select or empty panel.
    expect(h.clicks.some((c) => c.includes("data-bcl-prompt-opt-idx"))).toBe(true);
    expect(h.clicks.some((c) => c.includes("cc-opener"))).toBe(false);
    expect(h.clicks.some((c) => c.includes("cc-select"))).toBe(false);
    expect(h.clicks.some((c) => c.includes("cc-empty-panel"))).toBe(false);
    expect(h.window.document.querySelectorAll("[data-bcl-prompt-idx]").length).toBeLessThanOrEqual(1);
  });
});
