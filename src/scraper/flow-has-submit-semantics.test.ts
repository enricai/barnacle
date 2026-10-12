import { describe, expect, it } from "vitest";

import { flowHasSubmitSemantics, isStepSubmitShaped } from "@/scraper/flow-runner";

describe("scraper/flow-runner flowHasSubmitSemantics", () => {
  it("returns false when no step submits and no submit-endpoint shape is declared (read-only flow)", () => {
    const result = flowHasSubmitSemantics({
      steps: [{ submitStep: false }, { submitStep: false }],
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
    });

    expect(result).toBe(false);
  });

  it("returns true when any step declares submitStep:true", () => {
    const result = flowHasSubmitSemantics({
      steps: [{ submitStep: false }, { submitStep: true }],
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
    });

    expect(result).toBe(true);
  });

  it("returns true when submitEndpointPattern is non-null even with no submitStep", () => {
    const result = flowHasSubmitSemantics({
      steps: [{ submitStep: false }],
      submitEndpointPattern: "/api/submit",
      requireSubmitEndpointMatch: false,
    });

    expect(result).toBe(true);
  });

  it("returns true when requireSubmitEndpointMatch is true alone", () => {
    const result = flowHasSubmitSemantics({
      steps: [{ submitStep: false }],
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: true,
    });

    expect(result).toBe(true);
  });

  it("returns false when an earlier, non-final step submits but the final step does not", () => {
    const result = flowHasSubmitSemantics({
      steps: [{ submitStep: false }, { submitStep: true }, { submitStep: false }],
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
    });

    expect(result).toBe(false);
  });

  it("returns false for an empty step list with no submit shape", () => {
    const result = flowHasSubmitSemantics({
      steps: [],
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
    });

    expect(result).toBe(false);
  });
});

describe("scraper/flow-runner isStepSubmitShaped with flow-level inference", () => {
  const FLOW = {
    steps: [{ submitStep: false }, { submitStep: false }],
    submitEndpointPattern: "/api/submit",
    requireSubmitEndpointMatch: true,
  };

  it("keeps flow-level submit semantics true when no step carries the submitStep flag", () => {
    expect(flowHasSubmitSemantics(FLOW)).toBe(true);
  });

  it("does not infer submit shape onto a final step whose instruction declares it non-submit", () => {
    expect(
      isStepSubmitShaped({
        step: "Click a category tab on example.com. Do NOT click 'Book Now' or any control that proceeds to checkout.",
        submitStep: false,
        isFinalStep: true,
        flowHasSubmitSemantics: flowHasSubmitSemantics(FLOW),
      })
    ).toBe(false);
  });

  it("still infers submit shape onto an unflagged final step with neutral wording", () => {
    expect(
      isStepSubmitShaped({
        step: "Click the category tab",
        submitStep: false,
        isFinalStep: true,
        flowHasSubmitSemantics: flowHasSubmitSemantics(FLOW),
      })
    ).toBe(true);
  });
});
