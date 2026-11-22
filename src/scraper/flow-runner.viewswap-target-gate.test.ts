import { describe, expect, it } from "vitest";
import { isClickViewSwapVerified } from "./flow-runner.js";

const base = {
  resolvedAction: { method: "click" },
  submitStep: false,
  isAdvanceWithPattern: false,
  networkDelta: 0,
  bytesDelta: 900,
  textChanged: true,
};

describe("isClickViewSwapVerified target gate", () => {
  it("credits when target named or unspecified", () => {
    expect(isClickViewSwapVerified(base)).toBe(true);
    expect(
      isClickViewSwapVerified({
        ...base,
        resolvedElementNamesStepTarget: true,
      }),
    ).toBe(true);
  });
  it("does not credit when resolved element contradicts target", () => {
    expect(
      isClickViewSwapVerified({
        ...base,
        resolvedElementNamesStepTarget: false,
      }),
    ).toBe(false);
  });
});
