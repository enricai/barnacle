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

function enterKeyDowns(cdpEvents: { method: string; params: unknown }[]): number {
  return cdpEvents.filter((e) => {
    const p = e.params as { type?: string; key?: string } | undefined;
    return e.method === "Input.dispatchKeyEvent" && p?.type === "keyDown" && p.key === "Enter";
  }).length;
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

describe("flow-runner layered widget model (alias suite)", () => {
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
});
