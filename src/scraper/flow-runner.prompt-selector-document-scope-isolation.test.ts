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

type Popup = Parameters<typeof buildPromptWidgetHarness>[0]["popupByWidgetId"][string];

async function runStep(popup: Popup): Promise<{
  window: ReturnType<typeof buildPromptWidgetHarness>["window"];
  fills: { selector: string; value: string }[];
  clicks: string[];
  trajectory: { targetId?: string }[];
}> {
  const stagehand = {
    act: vi.fn(),
    observe: vi.fn().mockResolvedValue([]),
  } as unknown as Stagehand;
  const { page, target, window, fills, clicks } = buildPromptWidgetHarness({
    html: HTML,
    popupByWidgetId: { b: popup },
  });
  const trajectory: { targetId?: string }[] = [];
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
    trajectory,
  } as never);
  return { window, fills, clicks, trajectory };
}

describe("flow-runner/tryPromptSelectorPrimitive sibling isolation under unresolved scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["unlinked portal", { options: ["Porto"], portaled: true, unlinkedPortal: true }],
    [
      "unlinked searchable portal (filter fill + post-filter poll)",
      { options: ["Porto"], portaled: true, unlinkedPortal: true, searchable: true },
    ],
    [
      "late aria-controls, searchable",
      {
        options: ["Porto"],
        portaled: true,
        searchable: true,
        linkAfterOpen: true,
        linkDelayMs: 300,
      },
    ],
  ] as [string, Popup][])(
    "%s: never types into or reads from the sibling widget",
    async (_n, popup) => {
      const { window, fills, clicks, trajectory } = await runStep(popup);
      const doc = window.document;

      expect(doc.getElementById("a--input")?.hasAttribute(SEARCH_MARK)).toBe(false);
      expect(doc.getElementById("chip-a")?.hasAttribute(OPTION_MARK)).toBe(false);
      expect((doc.getElementById("a--input") as unknown as { value: string }).value).toBe("");
      expect(fills.every((f) => !f.selector.includes("a--input"))).toBe(true);
      expect(clicks.some((c) => c.includes("chip-a"))).toBe(false);
      expect(testLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("Lisbon"));
      for (const t of trajectory) expect(t.targetId).not.toBe("a");
    }
  );

  it("late aria-controls (button trigger): options come from the linked listbox and commit to B", async () => {
    const { window, trajectory } = await runStep({
      options: ["Porto"],
      portaled: true,
      linkAfterOpen: true,
      linkDelayMs: 300,
    });
    const doc = window.document;
    expect(doc.getElementById("chip-a")?.hasAttribute(OPTION_MARK)).toBe(false);
    expect(trajectory.length).toBeGreaterThan(0);
    expect(trajectory.at(-1)?.targetId).toBe("b");
  });
});
