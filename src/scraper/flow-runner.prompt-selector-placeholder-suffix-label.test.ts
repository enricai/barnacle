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

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const widgetHtml = (label: string) => `
<div>
  <div class="field">
    <button id="ccWidget" role="combobox" aria-haspopup="listbox" type="button"
            aria-label="${label}">— Make a Selection —</button>
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

async function run(label: string, question: string, act = vi.fn()) {
  const h = buildPromptWidgetHarness({
    html: widgetHtml(label),
    popupByWidgetId: { ccWidget: { options: ["+1 United States", "+47 Norway"] } },
  });
  const merged = {
    ...baseParams(h.page as unknown as Page, act, ""),
    frameTarget: h.target,
    step: `for '${question}' select '+47 Norway'`,
  };
  const result = await executeStepWithHealing(
    merged as unknown as Parameters<typeof executeStepWithHealing>[0]
  ).catch(() => "failed");
  return { result, h };
}

describe("flow-runner/tryPromptSelectorPrimitive placeholder-suffixed aria-label", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("matches a widget whose aria-label carries a trailing placeholder and commits the option", async () => {
    const act = vi.fn();
    const { result, h } = await run(
      "Country Code \u2014 Make a Selection \u2014",
      "Phone Country Code",
      act
    );
    expect(result).toBe("completed");
    expect(act).not.toHaveBeenCalled();
    expect(h.window.document.getElementById("ccWidget")?.textContent?.trim()).toBe("+47 Norway");
  });

  it("treats a placeholder-only aria-label as unlabelled, deferring to the <label for> lookup", async () => {
    const h = buildPromptWidgetHarness({
      html: `<div><label for="ccWidget">Country Code</label>
        <button id="ccWidget" role="combobox" aria-haspopup="listbox" type="button"
          aria-label="\u2014 Make a Selection \u2014">\u2014 Make a Selection \u2014</button></div>`,
      popupByWidgetId: { ccWidget: { options: ["+1 United States", "+47 Norway"] } },
    });
    const merged = {
      ...baseParams(h.page as unknown as Page, vi.fn(), ""),
      frameTarget: h.target,
      step: "for 'Phone Country Code' select '+47 Norway'",
    };
    const result = await executeStepWithHealing(
      merged as unknown as Parameters<typeof executeStepWithHealing>[0]
    ).catch(() => "failed");
    expect(result).toBe("completed");
    expect(h.window.document.getElementById("ccWidget")?.textContent?.trim()).toBe("+47 Norway");
  });

  it("does not match an unrelated question against a placeholder-suffixed label", async () => {
    const { h } = await run("Country Code \u2014 Make a Selection \u2014", "Preferred Locations");
    expect(h.window.document.getElementById("ccWidget")?.textContent?.trim()).not.toBe(
      "+47 Norway"
    );
  });
});
