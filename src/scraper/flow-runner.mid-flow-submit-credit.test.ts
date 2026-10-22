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

  it("credits a text-only advance with no byte delta", () => {
    expect(isClickViewSwapVerified({ ...BASE, midFlowSubmit: true, bytesDelta: 0 })).toBe(true);
  });

  it("credits an advance that replaced the clicked control", () => {
    expect(
      isClickViewSwapVerified({ ...BASE, midFlowSubmit: true, clickedElementStillPresent: false })
    ).toBe(true);
  });

  it("rejects when the text is unchanged or the advance judgement is negative", () => {
    expect(isClickViewSwapVerified({ ...BASE, midFlowSubmit: true, textChanged: false })).toBe(
      false
    );
    expect(isClickViewSwapVerified({ ...BASE, midFlowSubmit: true, pageAdvanced: false })).toBe(
      false
    );
  });

  it("vetoes an implausible destination even with the flag", () => {
    expect(
      isClickViewSwapVerified({ ...BASE, midFlowSubmit: true, destinationPlausible: false })
    ).toBe(false);
  });

  it("credits an advanced page that carries invalid markers", () => {
    expect(isClickViewSwapVerified({ ...BASE, midFlowSubmit: true, invalidMarkerDelta: 1 })).toBe(
      true
    );
  });
});

describe("isClickViewSwapVerified mid-flow submit with an unreported gesture", () => {
  const advance = { ...BASE, midFlowSubmit: true, bytesDelta: 0 };

  it("credits a successful act that listed no resolved action", () => {
    expect(isClickViewSwapVerified({ ...advance, resolvedAction: null, actSucceeded: true })).toBe(
      true
    );
  });

  it("does not credit an act that did not succeed", () => {
    expect(isClickViewSwapVerified({ ...advance, resolvedAction: null })).toBe(false);
  });

  it("credits a non-click, non-state-class method but not a state-class one", () => {
    expect(isClickViewSwapVerified({ ...advance, resolvedAction: { method: "press" } })).toBe(true);
    expect(isClickViewSwapVerified({ ...advance, resolvedAction: { method: "fill" } })).toBe(false);
  });

  it("keeps the vetoes when the action is unreported", () => {
    expect(
      isClickViewSwapVerified({
        ...advance,
        resolvedAction: null,
        actSucceeded: true,
        destinationPlausible: false,
      })
    ).toBe(false);
    expect(
      isClickViewSwapVerified({
        ...advance,
        resolvedAction: null,
        actSucceeded: true,
        textChanged: false,
      })
    ).toBe(false);
  });

  it("never credits an unreported action on a non-mid-flow step", () => {
    expect(
      isClickViewSwapVerified({
        ...advance,
        midFlowSubmit: false,
        resolvedAction: null,
        actSucceeded: true,
      })
    ).toBe(false);
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
      })
    ).toBe(false);
  });

  // runHealingFlow and recon-browser derive finality from the whole flow's
  // steps/plan (replans splice plan in place), never from an executed slice.
  it("derives finality per index over the full flow: only the last index is final", () => {
    const steps = ["Click Create Account", "Fill the name", "Click Submit"];
    const verdicts = steps.map((s, i) =>
      isMidFlowSubmitShapedStep({
        step: s,
        submitStep: true,
        isFinalStep: i === steps.length - 1,
        flowHasSubmitSemantics: true,
      })
    );
    expect(verdicts).toEqual([true, true, false]);
  });
});

describe("final submit keeps strict proof", () => {
  it("does not credit a final submit on a text swap with no network or URL proof", () => {
    expect(isClickViewSwapVerified({ ...BASE, midFlowSubmit: false, textChanged: true })).toBe(
      false
    );
    expect(
      isClickViewSwapVerified({
        ...BASE,
        midFlowSubmit: false,
        bytesDelta: 0,
        pageAdvanced: true,
        resolvedElementIsSubmitShaped: true,
        submitStep: false,
      })
    ).toBe(false);
  });

  it("derives a plan slice's last step as mid-flow when finality comes from the full flow", () => {
    const full = ["Click Continue", "Click Next", "Click Submit"];
    const slice = full.slice(0, 2);
    const verdicts = slice.map((s, i) =>
      isMidFlowSubmitShapedStep({
        step: s,
        submitStep: true,
        isFinalStep: i === full.length - 1,
        flowHasSubmitSemantics: true,
      })
    );
    expect(verdicts).toEqual([true, true]);
  });
});
