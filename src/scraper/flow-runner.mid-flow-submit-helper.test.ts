import { describe, expect, it } from "vitest";
import { isMidFlowSubmitShapedStep } from "@/scraper/flow-runner";

const base = {
  step: "fill the email field",
  submitStep: false,
  isFinalStep: false,
  flowHasSubmitSemantics: false,
};

describe("isMidFlowSubmitShapedStep", () => {
  it("is true for a step-derived submit that is not final", () => {
    expect(isMidFlowSubmitShapedStep({ ...base, submitStep: true })).toBe(true);
  });
  it("is true when only the resolved element is submit-shaped", () => {
    expect(isMidFlowSubmitShapedStep({ ...base, elementSubmitShaped: true })).toBe(true);
  });
  it("is false for a plain non-final step", () => {
    expect(isMidFlowSubmitShapedStep(base)).toBe(false);
  });
  it("is always false on the final step", () => {
    expect(
      isMidFlowSubmitShapedStep({
        ...base,
        isFinalStep: true,
        submitStep: true,
        elementSubmitShaped: true,
      })
    ).toBe(false);
  });
});
