import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Regression coverage for `tryPromptSelectorPrimitive` (see the report
 * `recon-focused-probe-blind-to-workday-prompt-widgets.md`): Workday's
 * button-triggered popup dropdown widget (`promptIcon`/`promptSelectionLabel`/
 * `multiSelectContainer`, options rendered on demand as
 * `data-automation-id="promptOption"`) carries no `<select>` and no
 * accessible role the focused probe / observe cascade resolves, so a
 * required My Information field answered only by this widget previously left
 * the wizard walled at step 1 of 7.
 *
 * Since the primitive drives the page through opaque `page.evaluate(expr)`
 * strings, these tests fake `evaluate` by inspecting distinguishing
 * substrings in `expr` — the same style `flow-runner.test.ts`'s
 * `runHealingFlow`/`fakeFlowPage` suite already uses for the sibling select/
 * radio primitives — rather than running a real DOM engine.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const STEP = "for 'What is your preferred phone type?' select 'Mobile'";

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
 * Fake page whose `evaluate` answers the prompt-selector primitive's two
 * enumerate passes (widget, then popup options) and its final commit
 * readback, and answers every OTHER primitive's probe (select/checkbox/radio/
 * required-select/DOM-snapshot/invalid-count) with an absent/zero result so
 * only the prompt-selector primitive claims the step.
 */
function fakePromptWidgetPage(params: {
  widgetLabel: string;
  optionTexts: string[];
  committedAfterClick: boolean;
}): { page: Page; locatorClick: ReturnType<typeof vi.fn> } {
  const locatorClick = vi.fn().mockResolvedValue(undefined);
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("outerHTML")) return { html: 50_000, text: "0:" };
    // Order matters: the readback expr references "promptSelectionLabel" too,
    // so check the most specific marker ("wantText") first.
    if (src.includes("wantText")) {
      return { ok: params.committedAfterClick, id: "phoneType-widget" };
    }
    if (src.includes("promptOption")) {
      return {
        optionsPresent: true,
        searchable: false,
        options: params.optionTexts.map((text, oIdx) => ({ oIdx, text })),
      };
    }
    if (src.includes("promptIcon")) {
      return {
        widgetPresent: true,
        candidates: [{ wIdx: 0, label: params.widgetLabel }],
      };
    }
    // <select>/checkbox/radio/required-select probes and the invalid-marker
    // count all see an absent page.
    if (src.includes("isInvalid(el)")) return 0;
    return null;
  });
  const page = {
    evaluate,
    url: () => "https://acme.wd1.myworkdayjobs.com/en-US/acme/apply/job/1",
    title: vi.fn().mockResolvedValue("Apply"),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        click: locatorClick,
        fill: vi.fn().mockResolvedValue(undefined),
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
  return { page, locatorClick };
}

function baseParams(page: Page, stagehandAct: ReturnType<typeof vi.fn>) {
  const stagehand = {
    act: stagehandAct,
    observe: vi.fn().mockResolvedValue([]),
  } as unknown as Stagehand;
  return {
    stagehand,
    page,
    step: STEP,
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

describe("flow-runner/tryPromptSelectorPrimitive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the popup, clicks the deterministically-matched option, and resolves the step without reaching the cascade", async () => {
    const stagehandAct = vi.fn();
    const { page, locatorClick } = fakePromptWidgetPage({
      widgetLabel: "What is your preferred phone type?",
      optionTexts: ["Home", "Mobile", "Work"],
      committedAfterClick: true,
    });

    const result = await executeStepWithHealing(baseParams(page, stagehandAct));

    expect(result).toBe("completed");
    // Two real clicks: the trigger (opens the popup) and the matched option.
    expect(locatorClick).toHaveBeenCalledTimes(2);
    // The cascade (stagehand act/observe) is never reached once the
    // primitive claims the step.
    expect(stagehandAct).not.toHaveBeenCalled();
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
  });

  it("falls through to the cascade unchanged when the popup's option click doesn't commit", async () => {
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const { page } = fakePromptWidgetPage({
      widgetLabel: "What is your preferred phone type?",
      optionTexts: ["Home", "Mobile", "Work"],
      committedAfterClick: false,
    });
    const stagehand = {
      act: stagehandAct,
      observe: vi
        .fn()
        .mockResolvedValue([{ selector: "button", description: "phone type", method: "click" }]),
    } as unknown as Stagehand;

    const params = { ...baseParams(page, stagehandAct), stagehand };
    // The primitive falls through and the cascade's minimal fake act/observe
    // never produces a verifiable effect either — only the fallthrough log
    // from the primitive is under test here, not the cascade's outcome.
    await executeStepWithHealing(params).catch(() => undefined);

    // The primitive logged a fallthrough rather than a resolved-by claim.
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by prompt-selector primitive")
    );
    expect(testLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("prompt-selector primitive: selection")
    );
  });
});
