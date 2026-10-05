import { describe, expect, it } from "vitest";
import { isClickViewSwapVerified } from "@/scraper/flow-runner";

/**
 * `isClickViewSwapVerified` (attempt-1's view-swap credit path) had no URL
 * or destination input anywhere in its signature or body — it credited a
 * click purely from `networkDelta===0` plus `bytesDelta`/`textChanged`
 * magnitude thresholds, so a non-submit click that bounced to any
 * unrelated page (e.g. a settings-panel tab switcher landing on an
 * unrelated marketing page) with a big enough DOM delta was credited the
 * same way a genuine same-page toggle is credited.
 *
 * Pins the `destinationPlausible` veto: `false` withholds credit even
 * when every byte/text threshold clears, and the same deltas still
 * credit when `destinationPlausible` is anything other than `false`
 * (including omitted, matching the existing-caller-unaffected contract).
 */
describe("isClickViewSwapVerified destination-plausibility veto", () => {
  const baseParams = {
    resolvedAction: { method: "click" },
    submitStep: false,
    isAdvanceWithPattern: false,
    networkDelta: 0,
    bytesDelta: 12_000,
    textChanged: true,
  };

  it("returns false when destinationPlausible===false even though bytesDelta/textChanged clear their thresholds", () => {
    expect(
      isClickViewSwapVerified({
        ...baseParams,
        destinationPlausible: false,
      })
    ).toBe(false);
  });

  it("still returns true for the same deltas when destinationPlausible!==false", () => {
    expect(
      isClickViewSwapVerified({
        ...baseParams,
        destinationPlausible: true,
      })
    ).toBe(true);
  });

  it("still returns true for the same deltas when destinationPlausible is omitted", () => {
    expect(isClickViewSwapVerified(baseParams)).toBe(true);
  });

  it("composes with the existing invalidMarkerDelta veto — both must clear for credit", () => {
    expect(
      isClickViewSwapVerified({
        ...baseParams,
        destinationPlausible: true,
        invalidMarkerDelta: 1,
      })
    ).toBe(false);
    expect(
      isClickViewSwapVerified({
        ...baseParams,
        destinationPlausible: false,
        invalidMarkerDelta: 0,
      })
    ).toBe(false);
  });

  it("composes with the existing clickedElementStillPresent veto — both must clear for credit", () => {
    expect(
      isClickViewSwapVerified({
        ...baseParams,
        destinationPlausible: true,
        clickedElementStillPresent: false,
      })
    ).toBe(false);
  });
});
