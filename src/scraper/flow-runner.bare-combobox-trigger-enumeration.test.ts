import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

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
    <label for="a">Departure city</label>
    <div id="a" role="combobox" aria-expanded="false" tabindex="0"></div>
  </div>
  <div>
    <label for="b">Arrival city</label>
    <div id="b" role="combobox" aria-expanded="false" tabindex="0"></div>
  </div>
</form>`;

async function run(popupId: string, step: string) {
  const stagehand = {
    act: vi.fn(),
    observe: vi.fn().mockResolvedValue([]),
  } as unknown as Stagehand;
  const { page, target, window, clicks } = buildPromptWidgetHarness({
    html: HTML,
    popupByWidgetId: { [popupId]: { options: ["Porto"], portaled: true } },
  });
  await executeStepWithHealing({
    stagehand,
    page: page as unknown as Page,
    frameTarget: target,
    step,
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
  return { doc: window.document, clicks };
}

describe("flow-runner prompt primitive with bare role=combobox[aria-expanded] triggers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens only the targeted bare combobox and enumerates its popup option", async () => {
    const { doc, clicks } = await run("b", "for 'Arrival city' select 'Porto'");
    expect(clicks.length).toBeGreaterThan(0);
    // The non-target combobox must never be opened by the broadened union.
    expect(clicks.some((c) => c.includes("#a") || c.includes("'a'"))).toBe(false);
    expect(doc.getElementById("a")?.getAttribute("aria-expanded")).toBe("false");
  });
});
