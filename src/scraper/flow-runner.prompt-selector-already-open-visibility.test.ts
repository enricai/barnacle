import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const WIDGET = (popup: string): string => `
<div>
  <div role="group" aria-labelledby="phone-section">
    <span id="phone-section">Phone</span>
    <label for="phoneType"><span>Phone Device Type</span></label>
    <button id="phoneType" aria-controls="pop" aria-haspopup="listbox" type="button"
            aria-invalid="true" aria-label="Phone Device Type Required"></button>
    ${popup}
  </div>
</div>`;

async function run(popup: string): Promise<string[]> {
  const h = buildPromptWidgetHarness({
    html: WIDGET(popup),
    popupByWidgetId: { phoneType: { options: ["Mobile", "Home"] } },
  });
  await executeStepWithHealing({
    stagehand: vi.fn() as never,
    page: h.page as Page,
    frameTarget: h.target,
    step: "for 'Phone Device Type' select 'Mobile'",
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
      `<div id="pop" style="display:none"><ul role="listbox"><li role="option">Mobile</li></ul></div>`
    );
    expect(clicks.some((c) => c.includes("bcl-prompt-idx"))).toBe(true);
  });

  it("does not click the trigger when a visible option is rendered", async () => {
    const clicks = await run(
      `<div id="pop"><ul role="listbox"><li role="option">Mobile</li></ul></div>`
    );
    expect(clicks.some((c) => c.includes("bcl-prompt-idx"))).toBe(false);
  });
});
