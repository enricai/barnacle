import { describe, expect, it } from "vitest";
import {
  classifyStepSubmitIntent,
  flowHasSubmitSemantics,
  isStepDeclaredNonSubmit,
  isStepSubmitShaped,
} from "@/scraper/flow-runner";

const NON_SUBMIT_STEPS: Array<[string, string]> = [
  [
    "category tab with example list",
    "In the pricing panel for the selected sail date, click on a stateroom category tab or link (e.g. 'Inside', 'Outside', 'Verandah', or 'Suite') to view that category's per-cabin price for the selected date. Do NOT click 'Book Now', 'Reserve', 'Select', or any control that proceeds to checkout.",
  ],
  [
    "type card expansion",
    "On the sailing detail page, click the 'Verandah' stateroom type (or any stateroom type card/tab) to expand its list of stateroom sub-categories and their individual 'from $' prices. Do NOT click 'Reserve', 'Book Now', 'Pay', or anything that proceeds past stateroom selection.",
  ],
  [
    "explicit not-checkout statement",
    "Click the 'Continue' control that opens that item's own detail page. This is the selection view showing 'from $' prices; it is NOT checkout. Do NOT click 'Reserve', 'Book Now', 'Pay', 'Continue to Guest Info', or anything that proceeds past selection.",
  ],
];

const SUBMIT_WITH_GUARDRAIL = "Click 'Submit' to send the form. Do NOT click 'Cancel'.";

describe("declared non-submit step instructions through the submit-shape seam", () => {
  it.each(NON_SUBMIT_STEPS)("classifies %s as non-submit", (_name, step) => {
    expect(classifyStepSubmitIntent(step)).toBe("non-submit");
    expect(isStepDeclaredNonSubmit({ step, submitStep: false })).toBe(true);
  });

  it.each(NON_SUBMIT_STEPS)("%s is never submit-shaped, even as the final step", (_name, step) => {
    for (const isFinalStep of [true, false]) {
      expect(
        isStepSubmitShaped({ step, submitStep: false, isFinalStep, flowHasSubmitSemantics: true })
      ).toBe(false);
    }
  });

  it.each(NON_SUBMIT_STEPS)("%s stays submit-shaped when flagged submitStep", (_name, step) => {
    expect(isStepDeclaredNonSubmit({ step, submitStep: true })).toBe(false);
    expect(
      isStepSubmitShaped({
        step,
        submitStep: true,
        isFinalStep: false,
        flowHasSubmitSemantics: true,
      })
    ).toBe(true);
  });

  it("positive control: a real submit step with a guardrail stays submit", () => {
    expect(classifyStepSubmitIntent(SUBMIT_WITH_GUARDRAIL)).toBe("submit");
    expect(isStepDeclaredNonSubmit({ step: SUBMIT_WITH_GUARDRAIL, submitStep: false })).toBe(false);
    for (const isFinalStep of [true, false]) {
      expect(
        isStepSubmitShaped({
          step: SUBMIT_WITH_GUARDRAIL,
          submitStep: false,
          isFinalStep,
          flowHasSubmitSemantics: true,
        })
      ).toBe(true);
    }
  });
});

describe("flowHasSubmitSemantics with an earlier submit-wording step", () => {
  it("does not infer submit onto a final step when an earlier step owns submit", () => {
    expect(
      flowHasSubmitSemantics({
        steps: [
          { submitStep: false, instruction: SUBMIT_WITH_GUARDRAIL },
          { submitStep: false, instruction: NON_SUBMIT_STEPS[0][1] },
        ],
        submitEndpointPattern: "/api/submit",
        requireSubmitEndpointMatch: true,
      })
    ).toBe(false);
  });

  it("still infers submit onto the final step when earlier steps are non-submit", () => {
    expect(
      flowHasSubmitSemantics({
        steps: [
          { submitStep: false, instruction: NON_SUBMIT_STEPS[1][1] },
          { submitStep: false, instruction: "Click the final button" },
        ],
        submitEndpointPattern: "/api/submit",
        requireSubmitEndpointMatch: true,
      })
    ).toBe(true);
  });
});
