import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const WIDGET = (popup: string): string => `
<div role="group" aria-labelledby="s"><span id="s">Contact</span>
  <label for="t"><span>Phone Device Type</span></label>
  <div id="w" data-uxi-widget-type="multiselect">
    <div data-automation-id="promptSelectionLabel"></div>
    <button id="t" aria-haspopup="listbox" type="button" aria-invalid="true"></button>
    ${popup}
  </div>
</div>`;

async function run(popup: string): Promise<string[]> {
  const h = buildPromptWidgetHarness({
    html: WIDGET(popup),
    popupByWidgetId: { w: { options: ["Mobile", "Home"] } },
  });
  const stagehand = {
    context: {},
    act: vi.fn().mockResolvedValue({ success: true, message: "", actionDescription: "", actions: [] } as ActResult),
  } as unknown as Stagehand;
  await executeStepWithHealing({
    stagehand,
    page: h.page as Page,
    frameTarget: h.target,
    step: "Select Phone Device Type: Mobile",
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
    logger,
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
  } as never).catch(() => undefined);
  return h.clicks;
}

describe("prompt-selector alreadyOpen requires a visible option", () => {
  it("clicks the trigger when options sit in a display:none container", async () => {
    const clicks = await run(
      `<div style="display:none"><ul role="listbox"><li role="option">Mobile</li></ul></div>`
    );
    expect(clicks.length).toBeGreaterThan(0);
  });

  it("does not click the trigger when a visible option is rendered", async () => {
    const clicks = await run(`<ul role="listbox"><li role="option">Mobile</li></ul>`);
    expect(clicks.some((c) => c.includes("#t") || c.includes("button"))).toBe(false);
  });
});
