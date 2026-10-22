import { describe, expect, it } from "vitest";
import { isGenuineFinalSubmit, isSubmitRevealedInvalid } from "@/scraper/flow-runner";

const revealed = {
  isFinalStep: true,
  requireSubmitEndpoint: true,
  resolvedMethod: "click",
  effectSignals: "dom-grew-without-network",
  preSubmitInvalidCount: 0,
  postAttemptInvalidCount: 2,
};

describe("isSubmitRevealedInvalid mid-flow advance regression", () => {
  it("does not fire for a mid-flow submit that advanced, even with more invalid containers", () => {
    expect(isSubmitRevealedInvalid({ ...revealed, midFlowAdvanced: true })).toBe(false);
  });
  it("still fires for a genuine final submit that revealed invalid fields", () => {
    expect(isSubmitRevealedInvalid({ ...revealed, midFlowAdvanced: false })).toBe(true);
    expect(isSubmitRevealedInvalid(revealed)).toBe(true);
  });
  it("does not fire when the invalid count did not grow", () => {
    expect(isSubmitRevealedInvalid({ ...revealed, postAttemptInvalidCount: 0 })).toBe(false);
  });
  it("a genuine final submit is never treated as a mid-flow advance", () => {
    expect(isGenuineFinalSubmit({ isFinalStep: true, flowHasSubmitSemantics: true })).toBe(true);
    expect(isGenuineFinalSubmit({ isFinalStep: true, flowHasSubmitSemantics: false })).toBe(false);
  });
});
