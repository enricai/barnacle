import { describe, expect, it } from "vitest";
import { detectDrillDownFoldPlan } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A read-only GET search re-queried under a different facet.
 *
 * Both captures hit the SAME endpoint; only the query differs. The search's own
 * results carry `brandCode` and `size` values that the facet re-query then
 * sends as `brand`/`size`, which is what makes the structural detector pair
 * them as a per-item drill-down. The flow declares no `foldReturn`, so that
 * pairing is a phantom self-fold, and emitting it would freeze `qty`/`region`
 * — the facet variation the flow author deliberately recorded.
 */
function buildFacetRequeriedSearchSteps(): MulticallFixtureStep[] {
  const search = (query: string, timestamp: string): MulticallFixtureStep =>
    buildStep(`r${timestamp.slice(-1)}`, {
      url: `https://api.example.com/catalog/search?${query}`,
      requestPostData: null,
      method: "GET",
      timestamp,
      responseBody: {
        results: {
          items: [
            { id: "I1", brandCode: "CB", originCode: "MIA", size: 7 },
            { id: "I2", brandCode: "VI", originCode: "PCN", size: 5 },
          ],
        },
      },
    });

  return [
    search("qty=2&region=C", "2026-11-02T12:00:01.000Z"),
    // The facet re-query: same endpoint, threads "CB" and "7" from the first
    // response's own items, and varies qty/region at the same time.
    search("qty=3&region=A&brand=CB&size=7", "2026-11-02T12:00:02.000Z"),
  ];
}

/** `detectDrillDownFoldPlan` takes the unexported `ActionStep[]`; the shared fixture's
 * `MulticallFixtureStep` is structurally identical except for `produces` (`unknown[]` vs the
 * real `Produce[]`, always empty here — the detector never reads it), so a type-only cast
 * through the detector's own parameter type is safe. Mirrors `detectAll` in
 * `recon-generate-fold-plan.test.ts`, with the new flag exposed. */
function detectAll(
  steps: MulticallFixtureStep[],
  allowSelfEndpointDrill: boolean
): ReturnType<typeof detectDrillDownFoldPlan> {
  return detectDrillDownFoldPlan(
    steps as unknown as Parameters<typeof detectDrillDownFoldPlan>[0],
    null,
    allowSelfEndpointDrill
  );
}

describe("structural fold detection vs a facet-requeried read-only GET search", () => {
  it("invents a same-endpoint drill when self-endpoint drills are allowed (the default)", () => {
    // Pins the pre-fix behaviour so the guard below is demonstrably load-bearing:
    // with no author intent to distinguish, the detector does pair the two.
    const plans = detectAll(buildFacetRequeriedSearchSteps(), true);

    expect(plans.length).toBeGreaterThan(0);
  });

  it("invents nothing when the flow declared no foldReturn", () => {
    // The fix: a same-endpoint capture can only be a re-query of the search, so
    // it must not become a per-item drill. Without this, recon:generate dies in
    // assertNoFrozenVaryingDrillParams and emits no contract at all.
    const plans = detectAll(buildFacetRequeriedSearchSteps(), false);

    expect(plans).toEqual([]);
  });
});
