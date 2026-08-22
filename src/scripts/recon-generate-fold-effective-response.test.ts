import { describe, expect, it } from "vitest";
import { emitContractTs, selectEffectiveResponseBody } from "@/scripts/recon-generate";
import {
  buildMulticallHeterogeneousActionSteps,
  buildMulticallHeterogeneousActionStepsWithFoldedDrillDown,
  type MulticallFixtureStep,
} from "@/scripts/recon-generate-multicall-fixture";

/**
 * Pins the call site's schema-sample choice for a resolved fold plan:
 * `emitMultiStepExecuteHttp` returns the primary call's array folded with the
 * drill-down's fields (see recon-generate.ts's loop-and-merge block), so the
 * sample fed to schema/type inference at the emitContractTs call site must be
 * that SAME folded shape — never the primary call's flat, unfolded body —
 * or the emitted type disagrees with what executeHttp actually returns.
 */
describe("recon-generate — schema sample agrees with a resolved fold plan", () => {
  it("emits the drill-down's fields nested inside the array item type, not a flat unfolded body", () => {
    const steps: MulticallFixtureStep[] =
      buildMulticallHeterogeneousActionStepsWithFoldedDrillDown();
    const effectiveResponseBody = selectEffectiveResponseBody(true, steps, null);

    const source = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://api.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: effectiveResponseBody,
      responseBodySamples: [effectiveResponseBody],
      gql: false,
      gqlQuery: null,
      endpointPath: "/api/available-products",
      auxFiles: [],
      multiStepBody: `    return { data: r2 };`,
    });

    expect(source).toContain("totalAvailableListings");
    expect(source).toContain("products");
    expect(source).toContain("units");
    expect(source).toContain("exchangeRate");
  });

  it("non-fold flows: the sample and inferred schema are unchanged from the unfolded body", () => {
    const foldedSteps: MulticallFixtureStep[] =
      buildMulticallHeterogeneousActionStepsWithFoldedDrillDown();
    const plainSteps: MulticallFixtureStep[] = buildMulticallHeterogeneousActionSteps();

    const plainEffectiveResponseBody = selectEffectiveResponseBody(true, plainSteps, null);
    // No fold plan exists for the plain sequence (no terminal drill-down
    // call), so the sample is the re-queried inventory call's own body,
    // untouched by any array-merge.
    expect(plainEffectiveResponseBody).toBe(plainSteps[3]!.capture.responseBody);

    const emit = (responseBody: unknown): string =>
      emitContractTs({
        siteId: "test-site",
        pascal: "TestSite",
        baseUrl: "https://api.example.com",
        baseHeaders: { "Content-Type": "application/json" },
        minTime: 100,
        safeRps: 10,
        responseBody,
        responseBodySamples: [responseBody],
        gql: false,
        gqlQuery: null,
        endpointPath: "/api/available-products",
        auxFiles: [],
        multiStepBody: `    return { data: r2 };`,
      });

    expect(emit(plainEffectiveResponseBody)).toBe(emit(plainSteps[3]!.capture.responseBody));

    const foldedEffectiveResponseBody = selectEffectiveResponseBody(true, foldedSteps, null);
    expect(emit(foldedEffectiveResponseBody)).not.toBe(emit(plainEffectiveResponseBody));
  });
});
