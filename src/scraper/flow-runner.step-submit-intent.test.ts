import { describe, expect, it } from "vitest";

import { classifyStepSubmitIntent, isStepSubmitShaped } from "@/scraper/flow-runner";

const NEG =
  "Do NOT click 'Book Now', 'Reserve', 'Select', or any control that proceeds to checkout";

describe("scraper/flow-runner classifyStepSubmitIntent", () => {
  it("classifies an explicit negated-proceed declaration as non-submit", () => {
    expect(classifyStepSubmitIntent(`Open the listing on example.com. ${NEG}`)).toBe("non-submit");
    expect(classifyStepSubmitIntent(NEG)).toBe("non-submit");
  });

  it("classifies a click-submit instruction as submit", () => {
    expect(classifyStepSubmitIntent("click submit")).toBe("submit");
  });

  it("keeps submit when a guardrail is unrelated or the submit phrase is outside the negation", () => {
    expect(classifyStepSubmitIntent("Click submit. Do not click cancel.")).toBe("submit");
    expect(classifyStepSubmitIntent("Click submit. Do not submit twice")).toBe("submit");
  });

  it("returns unspecified for plain or bare-negation instructions", () => {
    expect(classifyStepSubmitIntent("Fill the name field")).toBe("unspecified");
    expect(classifyStepSubmitIntent("Do NOT click Book Now")).toBe("unspecified");
    expect(classifyStepSubmitIntent(null)).toBe("unspecified");
  });
});

describe("scraper/flow-runner isStepSubmitShaped", () => {
  it("keeps an explicit submitStep authoritative over a non-submit instruction", () => {
    expect(
      isStepSubmitShaped({ step: NEG, submitStep: true, isFinalStep: true, flowHasSubmitSemantics: true }),
    ).toBe(true);
  });

  it("vetoes final-step inference when the instruction declares non-submit", () => {
    expect(
      isStepSubmitShaped({ step: NEG, submitStep: false, isFinalStep: true, flowHasSubmitSemantics: true }),
    ).toBe(false);
  });

  it("infers submit from final step with flow semantics, or from submit wording", () => {
    expect(
      isStepSubmitShaped({ step: "Review", submitStep: false, isFinalStep: true, flowHasSubmitSemantics: true }),
    ).toBe(true);
    expect(
      isStepSubmitShaped({ step: "click submit", submitStep: false, isFinalStep: false, flowHasSubmitSemantics: false }),
    ).toBe(true);
    expect(
      isStepSubmitShaped({ step: "Review", submitStep: false, isFinalStep: true, flowHasSubmitSemantics: false }),
    ).toBe(false);
  });
});
