import { describe, expect, it } from "vitest";
import { flowHasSubmitSemantics, isMidFlowSubmitShapedStep } from "@/scraper/flow-runner";
import { classifyPhantomClick } from "@/scraper/phantom-click";

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
  it("is credited in a last slot without final-submit semantics", () => {
    expect(
      isMidFlowSubmitShapedStep({
        ...base,
        step: "Click Create Account",
        isFinalStep: true,
        submitStep: true,
      })
    ).toBe(true);
  });
  it("is false on a genuine final submit", () => {
    expect(
      isMidFlowSubmitShapedStep({
        ...base,
        isFinalStep: true,
        flowHasSubmitSemantics: true,
        submitStep: true,
        elementSubmitShaped: true,
      })
    ).toBe(false);
  });
});

describe("classifyPhantomClick genuine no-op", () => {
  const snap = {
    networkCount: 3,
    url: "https://example.com/apply",
    bodyHtmlLength: 5000,
    visibleTextSignature: "100:Sign In Create Account",
  };

  it("stays phantom for an identical-snapshot mid-flow submit click", () => {
    expect(
      classifyPhantomClick({
        actResultSuccess: true,
        pre: snap,
        post: { ...snap },
        destinationPlausible: true,
        isMidFlowSubmitStep: true,
      })
    ).toBe("phantom");
  });

  it("stays phantom for a final submit whose only change is a DOM reflow", () => {
    expect(
      classifyPhantomClick({
        actResultSuccess: true,
        pre: snap,
        post: { ...snap, bodyHtmlLength: 9000 },
        destinationPlausible: true,
        isSubmitShapedStep: true,
      })
    ).toBe("phantom");
  });
});

describe("isMidFlowSubmitShapedStep with derived flowHasSubmitSemantics", () => {
  it("credits a truncated plan whose last slot is a non-submit step", () => {
    const steps = [
      { submitStep: true, instruction: "Click Create Account" },
      { submitStep: false, instruction: "fill the email field" },
    ];
    const derived = flowHasSubmitSemantics({
      steps,
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
    });
    expect(derived).toBe(false);
    expect(
      isMidFlowSubmitShapedStep({
        step: "Click Create Account",
        submitStep: true,
        isFinalStep: true,
        flowHasSubmitSemantics: derived,
      })
    ).toBe(true);
  });
});
