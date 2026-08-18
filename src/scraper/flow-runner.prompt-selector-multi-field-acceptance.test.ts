import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { buildPromptWidgetHarness } from "@/scraper/prompt-widget-dom-harness.test-helper";
import type { Logger } from "@/types/logging";

/**
 * Acceptance regression for the report's actual failure shape: a single
 * "My Information"-style wizard page carrying SEVERAL required prompt-selector
 * widgets at once, phrased with a mix of "select …" (dropdown) and "click the
 * … answer" (radio-style) verbs, and backed ONLY by widget-kit/near-standard
 * controls — zero native `<select>` or `input[type=radio]` anywhere on the
 * page. `flow-runner.prompt-selector-widget.test.ts` and
 * `flow-runner.answer-phrased-prompt-selector.test.ts` each pin one gap in
 * isolation (disambiguation across two widgets; a single answer-phrased step);
 * this file drives the full multi-widget sequence end to end through
 * `executeStepWithHealing`, generalizing the report's 5-field page (source,
 * phone type, country, and two Yes/No screening questions) with vendor-neutral
 * labels, asserting every required field resolves rather than falling through
 * to the "no candidates after act+observe" skip branch or the probe's absent
 * branch.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function actResult(overrides: Partial<ActResult> = {}): ActResult {
  return {
    success: true,
    message: "clicked",
    actionDescription: "clicked",
    actions: [],
    ...overrides,
  };
}

/**
 * A "My Information"-style page carrying five required widget-kit prompt
 * widgets: three dropdown-shaped (source, phone type, country) and two
 * Yes/No screening questions (worked here before, eligible to work) — the
 * same `data-uxi-widget-type="selectinput"`/`"multiselect"` shape
 * `flow-runner.prompt-selector-widget.test.ts`'s `TWO_WIDGET_HTML` uses,
 * extended to five distinctly-labelled fields so each step's own label
 * disambiguates it from the other four. Zero native `<select>` or
 * `input[type=radio]` elements render anywhere.
 */
const MULTI_FIELD_PAGE_HTML = `
<div data-automation-id="applyFlowMyInfoPage">
  <div role="group" aria-labelledby="src-section">
    <span id="src-section">Contact</span>
    <div data-automation-id="formField-source">
      <label for="source--source"><span>How did you hear about us</span></label>
      <div id="source-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="source--source" data-uxi-widget-type="selectinput" type="text"
               placeholder="Search" aria-required="true" aria-invalid="true" value="" />
      </div>
    </div>
  </div>
  <div role="group" aria-labelledby="phone-section">
    <span id="phone-section">Phone</span>
    <div data-automation-id="formField-phoneType">
      <label for="phone--phoneType"><span>Phone type</span></label>
      <div id="phone-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="phone--phoneType" data-uxi-widget-type="selectinput" type="text"
               placeholder="Search" aria-required="true" aria-invalid="true" value="" />
      </div>
    </div>
  </div>
  <div role="group" aria-labelledby="country-section">
    <span id="country-section">Address</span>
    <div data-automation-id="formField-country">
      <label for="country--country"><span>Country</span></label>
      <div id="country-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="country--country" data-uxi-widget-type="selectinput" type="text"
               placeholder="Search" aria-required="true" aria-invalid="true" value="" />
      </div>
    </div>
  </div>
  <div role="group" aria-labelledby="worked-section">
    <span id="worked-section">Prior employment</span>
    <div data-automation-id="formField-workedBefore">
      <label for="worked--workedBefore"><span>Have you worked here before?</span></label>
      <div id="worked-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="worked--workedBefore" data-uxi-widget-type="selectinput" type="text"
               placeholder="Search" aria-required="true" aria-invalid="true" value="" />
      </div>
    </div>
  </div>
  <div role="group" aria-labelledby="eligibility-section">
    <span id="eligibility-section">Eligibility</span>
    <div data-automation-id="formField-eligibility">
      <label for="eligibility--eligibility"><span>Are you legally authorized to work?</span></label>
      <div id="eligibility-widget" data-uxi-widget-type="multiselect" data-automation-id="multiSelectContainer">
        <div data-automation-id="promptSelectionLabel"></div>
        <input id="eligibility--eligibility" data-uxi-widget-type="selectinput" type="text"
               placeholder="Search" aria-required="true" aria-invalid="true" value="" />
      </div>
    </div>
  </div>
</div>`;

/** The dropdown-phrased steps ("select … in the … dropdown") mixed with the answer-phrased steps ("click the … answer for …"), matching the report's mixed phrasing. */
const SOURCE_STEP = "Select 'LinkedIn' in the 'How did you hear about us' dropdown";
const PHONE_STEP = "Select 'Mobile' in the 'Phone type' dropdown";
const COUNTRY_STEP = "Select 'United States' in the 'Country' dropdown";
const WORKED_STEP = "Click the 'No' answer for the question 'Have you worked here before?'";
const ELIGIBILITY_STEP =
  "Click the 'Yes' answer for the question 'Are you legally authorized to work?'";

const STEPS = [SOURCE_STEP, PHONE_STEP, COUNTRY_STEP, WORKED_STEP, ELIGIBILITY_STEP];

function baseParams(page: Page, stagehandAct: ReturnType<typeof vi.fn>, stepIndex: number) {
  const stagehand = {
    act: stagehandAct,
    observe: vi.fn().mockResolvedValue([]),
  } as unknown as Stagehand;
  return {
    stagehand,
    page,
    optional: false,
    upload: false,
    submitStep: false,
    stepIndex,
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

describe("flow-runner multi-field prompt-widget wizard-page acceptance (widget-kit only, mixed step phrasing)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves every required field on a 5-widget My-Info-style page — select-verb and answer-verb steps alike — with none falling through to the skip/probe-absent branches", async () => {
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const { page, target, window, clicks } = buildPromptWidgetHarness({
      html: MULTI_FIELD_PAGE_HTML,
      popupByWidgetId: {
        "source-widget": { options: ["Job Board", "LinkedIn", "Referral"] },
        "phone-widget": { options: ["Home", "Mobile", "Work"] },
        "country-widget": { options: ["United States", "Canada", "Mexico"] },
        "worked-widget": { options: ["Yes", "No"] },
        "eligibility-widget": { options: ["Yes", "No"] },
      },
    });
    // Guard the fixture's own premise: no native <select> or radio inputs
    // render anywhere on the page.
    expect(window.document.querySelectorAll("select").length).toBe(0);
    expect(window.document.querySelectorAll('input[type="radio"]').length).toBe(0);

    const results: string[] = [];
    for (const [index, step] of STEPS.entries()) {
      const merged = {
        ...baseParams(page as unknown as Page, stagehandAct, index),
        frameTarget: target,
        step,
      };
      // Each step's DOM effect (widget marked filled/valid) must land before
      // the next step's disambiguation runs against it, so steps run
      // sequentially rather than concurrently.
      const result = await executeStepWithHealing(
        merged as unknown as Parameters<typeof executeStepWithHealing>[0]
      );
      results.push(result);
    }

    expect(results).toEqual(["completed", "completed", "completed", "completed", "completed"]);
    // Every field resolved via the DOM-direct prompt-selector primitive, not
    // Stagehand's act() cascade.
    expect(stagehandAct).not.toHaveBeenCalled();
    // At least a trigger click and an option click per widget.
    expect(clicks.length).toBeGreaterThanOrEqual(STEPS.length * 2);
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("skipped (optional, no candidates after act+observe)")
    );
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("skipped (optional, probe found no candidates)")
    );
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining(
        "no candidates after act+observe but a required unfilled control matches"
      )
    );

    // Each field's own dropdown/option markup actually rendered against the
    // widget the step targeted (not just that "completed" was returned) —
    // the resolved option is present under the matching widget container.
    expect(
      window.document.querySelector("#source-widget [data-automation-label='LinkedIn']")
    ).not.toBeNull();
    expect(
      window.document.querySelector("#phone-widget [data-automation-label='Mobile']")
    ).not.toBeNull();
    expect(
      window.document.querySelector("#country-widget [data-automation-label='United States']")
    ).not.toBeNull();
    expect(
      window.document.querySelector("#worked-widget [data-automation-label='No']")
    ).not.toBeNull();
    expect(
      window.document.querySelector("#eligibility-widget [data-automation-label='Yes']")
    ).not.toBeNull();
  });
});
