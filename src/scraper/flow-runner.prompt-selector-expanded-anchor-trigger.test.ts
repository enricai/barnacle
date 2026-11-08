import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

vi.mock("@/lib/llm/judges/select-option", () => ({
  judgeSelectOptionWithLLM: vi.fn(),
}));

/**
 * Regression coverage for a `role="option"` element with NO own accessible
 * text (empty `textContent`/`data-value`) whose label instead lives on
 * `aria-label`, `aria-labelledby`, `title`, or a descendant node. Previously
 * the enumeration read and the commit-verification readback both fell back to
 * raw `textContent`, so such an option could never be matched OR confirmed as
 * committed, even though the widget family renders and behaves identically to
 * one whose option text is inline.
 */

/**
 * A lone visible `role="combobox"` anchor that declares only `aria-expanded`
 * (no `aria-controls`/`aria-haspopup`) is still a popup trigger.
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

const anchorHtml = (label: string) =>
  `<div><a id="dropdown" role="combobox" aria-expanded="false" aria-label="${label} \u2014 Make a Selection \u2014"><span>\u2014 Make a Selection \u2014</span></a></div>`;

async function run(label: string, step: string) {
  const h = buildPromptWidgetHarness({
    html: anchorHtml(label),
    popupByWidgetId: { dropdown: { options: ["(+1) United States", "(+47) Norway"] } },
  });
  const act = vi.fn();
  const merged = { ...baseParams(h.page as unknown as Page, act, ""), frameTarget: h.target, step };
  const result = await executeStepWithHealing(
    merged as unknown as Parameters<typeof executeStepWithHealing>[0]
  ).catch(() => "failed");
  return { result, h, act };
}

describe("flow-runner/tryPromptSelectorPrimitive bare aria-expanded combobox anchor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects an option in an anchor combobox with only aria-expanded", async () => {
    const { result, h, act } = await run(
      "Country Code",
      "Select '(+1) United States' in the 'Country Code' dropdown"
    );
    expect(result).toBe("completed");
    expect(act).not.toHaveBeenCalled();
    expect(h.window.document.getElementById("dropdown")?.textContent).toContain(
      "(+1) United States"
    );
  });

  it("selects another option in a differently labelled anchor combobox", async () => {
    const { result, h } = await run(
      "Dialing Region",
      "Select '(+47) Norway' in the 'Dialing Region' dropdown"
    );
    expect(result).toBe("completed");
    expect(h.window.document.getElementById("dropdown")?.textContent).toContain("(+47) Norway");
  });
});
