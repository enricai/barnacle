import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

/**
 * Regression for bugfix-001: a `click` whose resolved element is a
 * {@link PROMPT_TRIGGER_SELECTORS}-shaped widget must not be credited via
 * `clickViewSwapVerified`/`formValueVerified` when the widget's own committed
 * value is still empty. Opening a prompt-selector popup renders its option
 * list, which alone grows `document.body.outerHTML` past the view-swap
 * byte threshold — exactly the false-positive shape the datepicker readback
 * gate (`shouldReadbackFillOnActSuccess`) already defeats for controlled
 * datepickers, extended here to this widget family.
 *
 * Uses the real-DOM harness (not a hand-authored evaluate stub) so the test
 * exercises the production `verifyPromptSelectorCommitted` expression string
 * against genuine markup, and genuine `outerHTML`/`innerText` deltas drive
 * `isClickViewSwapVerified` for real.
 */

const SILENT_LOGGER = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const WIDGET_HTML = `
<div data-automation-id="applyFlowMyInfoPage">
  <div role="group" aria-labelledby="source-section">
    <span id="source-section">Contact</span>
    <div data-automation-id="formField-source">
      <label for="source--source"><span>How Did You Hear About Us?</span></label>
      <div id="src-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="source--source" data-uxi-widget-type="selectinput" type="text"
               placeholder="Search" aria-required="true" aria-invalid="true" value="" />
      </div>
    </div>
  </div>
</div>`;

// Long, numerous option labels so opening the popup alone grows
// `document.body.outerHTML` past `VIEW_SWAP_MIN_BYTES` (default 5000) — the
// exact "popup opened, DOM grew, nothing committed" shape the report describes.
const MANY_OPTIONS = Array.from(
  { length: 40 },
  (_, i) =>
    `Referral Source Option Number ${i} - a long descriptive label padding out the popup markup`
);

function baseParams(page: Page, stagehandAct: ReturnType<typeof vi.fn>) {
  const stagehand = {
    act: stagehandAct,
    // Focused observe stays blind (every step verifies via act()'s own
    // reported action); unfocused observe (instruction omitted) returns a
    // stub "page has content" candidate so `probeStepBeforeAttempts`'s
    // reachability fallback hands off to the cascade instead of
    // short-circuiting to "absent" before act() ever runs.
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;
  return {
    stagehand,
    page,
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
    logger: SILENT_LOGGER,
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

describe("flow-runner prompt-selector committed-value readback gate (bugfix-001)", () => {
  it("does NOT credit a click that opens a prompt-selector popup but commits no option, via view-swap", async () => {
    const { page, target } = buildPromptWidgetHarness({
      html: WIDGET_HTML,
      popupByWidgetId: { "src-widget": { options: MANY_OPTIONS } },
    });

    const stagehandAct = vi.fn().mockImplementation(async (): Promise<ActResult> => {
      // Stagehand's act() resolves AND executes the click itself (matching
      // production: `guardedAct`/`stagehand.act()` performs the DOM
      // interaction directly, unlike the observe-act fallback). Opening the
      // popup is the ONLY DOM effect — no option is ever clicked.
      await (
        page as unknown as {
          locator: (s: string) => { first: () => { click: () => Promise<void> } };
        }
      )
        .locator("#src-widget")
        .first()
        .click();
      return {
        success: true,
        message: "clicked",
        actionDescription: "clicked How Did You Hear About Us dropdown",
        actions: [
          {
            // Real Stagehand `act()` resolutions are xpath (accessibility-tree
            // based), never `css=` — `verifyPromptSelectorCommitted`/
            // `verifyFillReadback` only resolve xpath selectors, matching the
            // resolved-action shape act() actually returns in production.
            selector: "xpath=//*[@id='src-widget']",
            description: "How Did You Hear About Us",
            method: "click",
          },
        ],
      };
    });

    const params = baseParams(page as unknown as Page, stagehandAct);
    const merged = {
      ...params,
      frameTarget: target,
      // Not select/fill/answer-shaped, so `tryPromptSelectorPrimitive` returns
      // null without touching the DOM and this reaches the act-string
      // cascade — the exact path the report's false positive rode.
      step: "Click the 'How Did You Hear About Us?' dropdown",
    };

    await expect(
      executeStepWithHealing(merged as unknown as Parameters<typeof executeStepWithHealing>[0])
    ).rejects.toMatchObject({ name: "StepVerificationError" });

    expect(stagehandAct).toHaveBeenCalled();
  });
});
