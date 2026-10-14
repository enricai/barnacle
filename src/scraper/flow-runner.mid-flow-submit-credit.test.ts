import { describe, expect, it } from "vitest";
import { isClickViewSwapVerified, isMidFlowSubmitShapedStep } from "@/scraper/flow-runner";

const BASE = {
  resolvedAction: { method: "click" },
  submitStep: true,
  isAdvanceWithPattern: false,
  networkDelta: 0,
  bytesDelta: 5000,
  textChanged: true,
};

describe("isClickViewSwapVerified mid-flow submit", () => {
  it("credits a mid-flow submit on a demonstrable advance", () => {
    expect(isClickViewSwapVerified({ ...BASE, midFlowSubmit: true })).toBe(true);
  });

  it("still rejects a submit-shaped step without the flag", () => {
    expect(isClickViewSwapVerified(BASE)).toBe(false);
  });

  it("rejects weak signals even with the flag", () => {
    expect(isClickViewSwapVerified({ ...BASE, midFlowSubmit: true, bytesDelta: 600 })).toBe(false);
    expect(isClickViewSwapVerified({ ...BASE, midFlowSubmit: true, textChanged: false })).toBe(
      false,
    );
  });

  it.each([
    { invalidMarkerDelta: 1 },
    { clickedElementStillPresent: false },
    { destinationPlausible: false },
  ])("vetoes %o even with the flag", (veto) => {
    expect(isClickViewSwapVerified({ ...BASE, midFlowSubmit: true, ...veto })).toBe(false);
  });
});

describe("isMidFlowSubmitShapedStep", () => {
  const step = { step: "Click Create Account", flowHasSubmitSemantics: true };

  it("is true for a non-final submit-shaped step", () => {
    expect(isMidFlowSubmitShapedStep({ ...step, submitStep: true, isFinalStep: false })).toBe(true);
  });

  it("is false for the final step", () => {
    expect(isMidFlowSubmitShapedStep({ ...step, submitStep: true, isFinalStep: true })).toBe(false);
  });

  it("is false for a non-submit step", () => {
    expect(
      isMidFlowSubmitShapedStep({
        step: "Click the Details tab",
        submitStep: false,
        isFinalStep: false,
        flowHasSubmitSemantics: false,
      }),
    ).toBe(false);
  });
});
