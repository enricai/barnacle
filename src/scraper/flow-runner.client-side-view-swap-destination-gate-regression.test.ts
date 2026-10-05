import { describe, expect, it } from "vitest";

import { isClickViewSwapVerified } from "@/scraper/flow-runner";

describe("flow-runner/isClickViewSwapVerified — destination-plausibility gate", () => {
  /**
   * A non-submit, non-advance click that clears every byte/text threshold
   * above must still be vetoed when the landing page is implausible for the
   * step (e.g. a settings-panel toggle that bounces to an unrelated page).
   */
  it("rejects a plain click with large DOM growth when destinationPlausible is false", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 49518,
      textChanged: false,
      destinationPlausible: false,
    });
    expect(result).toBe(false);
  });

  /**
   * The identical params with destinationPlausible explicitly true matches
   * today's pre-fix default behavior — the veto only fires on a confirmed
   * false.
   */
  it("credits a plain click with large DOM growth when destinationPlausible is true", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 49518,
      textChanged: false,
      destinationPlausible: true,
    });
    expect(result).toBe(true);
  });

  /**
   * Callers that omit destinationPlausible entirely (every existing case in
   * flow-runner.client-side-view-swap.test.ts) are unaffected — the param
   * defaults to no-veto.
   */
  it("still credits a plain click with large DOM growth when destinationPlausible is omitted (default callers)", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 49518,
      textChanged: false,
    });
    expect(result).toBe(true);
  });

  it("rejects a small text-changing reveal when destinationPlausible is false", () => {
    const result = isClickViewSwapVerified({
      resolvedAction: { method: "click" },
      submitStep: false,
      isAdvanceWithPattern: false,
      networkDelta: 0,
      bytesDelta: 789,
      textChanged: true,
      destinationPlausible: false,
    });
    expect(result).toBe(false);
  });
});
