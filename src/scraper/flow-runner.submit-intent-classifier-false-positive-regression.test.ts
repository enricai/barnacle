import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyStepSubmitIntent,
  flowHasSubmitSemantics,
  type HealingFlowStep,
  isAdvanceStep,
  isStepDeclaredNonSubmit,
  isStepSubmitShaped,
  isSubmitIntentStep,
  runHealingFlow,
} from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Regression guard for the false-positive boundary of `isSubmitIntentStep`
 * (added to close the flag-independent submit-shape gap; see
 * `flow-runner.submit-flow-phantom-click-regression.test.ts` for the
 * true-positive counterpart). The classifier is additive — ORed into the
 * existing `submitStep || (isFinalStep && flowHasSubmitSemantics)` gate — so
 * its only way to regress the ladder is by firing on a step it must not.
 * This file proves it doesn't, both at the unit level (the composed
 * submit-shape boolean itself) and at the acceptance level (an ordinary
 * step's phantom click must still exhaust the full ladder instead of being
 * routed to deep-submit-locator).
 */

function submitShapedBoolean(params: {
  step: string;
  submitStep: boolean;
  isFinalStep: boolean;
  flowHasSubmitSemanticsFlag: boolean;
}): boolean {
  const { step, submitStep, isFinalStep, flowHasSubmitSemanticsFlag } = params;
  return submitStep || (isFinalStep && flowHasSubmitSemanticsFlag) || isSubmitIntentStep(step);
}

describe("submit-shape gate — isSubmitIntentStep does not misroute a non-submit step", () => {
  it("is false for an ordinary field-fill step, mid-flow and unflagged", () => {
    expect(
      submitShapedBoolean({
        step: "Fill in the First Name field with 'Reginald'",
        submitStep: false,
        isFinalStep: false,
        flowHasSubmitSemanticsFlag: true,
      })
    ).toBe(false);
  });

  it("is false for an advance/'Next' step matching isAdvanceStep's own phrases, mid-flow and unflagged", () => {
    const step = "Click the 'Next' button to leave the Basic Information page.";
    expect(isAdvanceStep(step)).toBe(true);
    expect(isSubmitIntentStep(step)).toBe(false);
    expect(
      submitShapedBoolean({
        step,
        submitStep: false,
        isFinalStep: false,
        flowHasSubmitSemanticsFlag: true,
      })
    ).toBe(false);
  });

  it("stays true for a step carrying the explicit submitStep flag, regardless of its own text", () => {
    expect(
      submitShapedBoolean({
        step: "Fill in the 'Submit Date' field with today's date",
        submitStep: true,
        isFinalStep: false,
        flowHasSubmitSemanticsFlag: true,
      })
    ).toBe(true);
  });

  it("stays true for the flow's genuinely final step under flowHasSubmitSemantics, regardless of its own text", () => {
    const steps = [{ submitStep: true }];
    const semantics = flowHasSubmitSemantics({
      steps,
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
    });

    expect(
      submitShapedBoolean({
        step: "Click 'Next' to continue to the next page",
        submitStep: false,
        isFinalStep: true,
        flowHasSubmitSemanticsFlag: semantics,
      })
    ).toBe(true);
  });
});

/**
 * Acceptance drive: a mid-flow, unflagged step whose instruction reads as an
 * ordinary "Next" advance — not a submit — must still run the full
 * observe-act/structured-click/observe-act-exclude ladder after a phantom
 * click on attempt 1, exactly as it did before `isSubmitIntentStep` existed.
 * If the classifier ever regressed to matching this step, the phantom click
 * would short-circuit straight to `deep-submit-locator` and skip the ladder
 * — the failure mode this test exists to catch.
 */
describe("flow-runner/runHealingFlow — non-submit advance step keeps the ordinary ladder after a phantom click", () => {
  const STEP = "Click the 'Next' button to leave the Basic Information page.";

  function actResult(overrides: Partial<ActResult> = {}): ActResult {
    return {
      success: true,
      message: "clicked",
      actionDescription: "Click the Next button",
      actions: [{ selector: "button#next", description: "Click the Next button", method: "click" }],
      ...overrides,
    };
  }

  function fakePage(): Page {
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("ranked.sort")) return [];
      if (src.includes('__mouse("click"')) return { clicked: false };
      if (src.includes("outerHTML")) return { html: 42000, text: "0:" };
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });
    return {
      evaluate,
      url: () => "https://portal.acme.example/basic-information",
      title: vi.fn().mockResolvedValue("Basic Information"),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
      mainFrameId: () => "main",
      sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
    } as unknown as Page;
  }

  const infoMock = vi.fn();
  const warnMock = vi.fn();
  const errorMock = vi.fn();
  const testLogger = {
    info: infoMock,
    warn: warnMock,
    error: errorMock,
    debug: vi.fn(),
  } as unknown as Logger;

  beforeEach(() => {
    infoMock.mockClear();
    warnMock.mockClear();
    errorMock.mockClear();
  });

  it("does not route the phantom click to deep-submit-locator — observe-act still runs", async () => {
    const stagehandAct = vi.fn().mockResolvedValue(actResult());
    const stagehandObserve = vi
      .fn()
      .mockResolvedValue([
        { selector: "button#next", description: "Next button", method: "click" },
      ]);
    const stagehand = { act: stagehandAct, observe: stagehandObserve } as unknown as Stagehand;

    const steps: HealingFlowStep[] = [
      { instruction: STEP, optional: false, upload: false, submitStep: false },
      {
        instruction: "Fill in the Last Name field with 'Doe'",
        optional: false,
        upload: false,
        submitStep: false,
      },
    ];

    await expect(
      runHealingFlow({
        stagehand,
        page: fakePage(),
        steps,
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      })
    ).rejects.toMatchObject({ name: "StepVerificationError" });

    expect(stagehandObserve).toHaveBeenCalled();

    const logged = [...infoMock.mock.calls, ...warnMock.mock.calls, ...errorMock.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");
    expect(logged).not.toContain("deep-submit-locator");
  });
});

describe("classifyStepSubmitIntent — declared non-submit instruction", () => {
  it("classifies a step that declares it must not proceed to checkout as non-submit", () => {
    expect(
      classifyStepSubmitIntent(
        "Click a category tab on example.com. Do NOT click 'Book Now' or any control that proceeds to checkout."
      )
    ).toBe("non-submit");
  });

  it("keeps a genuine submit click as submit, even alongside a guardrail", () => {
    expect(classifyStepSubmitIntent("Click 'submit' to finish")).toBe("submit");
    expect(
      classifyStepSubmitIntent(
        "Click the submit button. Do not click anything that proceeds to checkout."
      )
    ).toBe("submit");
  });

  it("returns unspecified for neutral or empty instructions", () => {
    expect(classifyStepSubmitIntent("Click the category tab")).toBe("unspecified");
    expect(classifyStepSubmitIntent(null)).toBe("unspecified");
  });

  it("vetoes inferred submit shape regardless of final-step or flow flags, but not an explicit submitStep", () => {
    const step = "Open the details tab. Never click anything that proceeds to checkout.";
    expect(
      isStepSubmitShaped({
        step,
        submitStep: false,
        isFinalStep: true,
        flowHasSubmitSemantics: true,
      })
    ).toBe(false);
    expect(
      isStepSubmitShaped({
        step,
        submitStep: true,
        isFinalStep: true,
        flowHasSubmitSemantics: true,
      })
    ).toBe(true);
  });
});

describe("isStepDeclaredNonSubmit", () => {
  const NEGATED = "Do NOT click Place Order or any control that proceeds to checkout";

  it("is true for a negated guardrail without submitStep", () => {
    expect(isStepDeclaredNonSubmit({ step: NEGATED, submitStep: false })).toBe(true);
  });

  it("is false when submitStep is explicitly set", () => {
    expect(isStepDeclaredNonSubmit({ step: NEGATED, submitStep: true })).toBe(false);
  });

  it("is false for ordinary and empty instructions", () => {
    expect(isStepDeclaredNonSubmit({ step: "Click Submit", submitStep: false })).toBe(false);
    expect(isStepDeclaredNonSubmit({ step: null, submitStep: false })).toBe(false);
  });
});
