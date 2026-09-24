import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveFoldPlan } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

const BASE = "https://api.example.com";

/**
 * A search primary with a SINGLE item driving exactly ONE per-item
 * drill-down call — not the two-target "shared guess" shape covered by
 * recon-generate-foldreturn-declared-joinfields-shared-structural-guess-override-unit.test.ts.
 * mergeSpecPlanOntoSamePrimary resolves the declared override per structural
 * TARGET (recon-generate.ts:9903-9928, keyed by each target's own drill
 * endpoint), which a single-target fixture exercises through a materially
 * different path than the multi-target per-item loop: there's only ever one
 * `plan.targets` entry to map over. The drill's request threads
 * `pricing.currency`/`pricing.taxIncluded` (the structural heuristic's
 * guess), while only the response-only, always-present `voyageId` field is
 * declared as the join.
 */
function buildSingleTargetStructuralGuessDrillDownSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: `${BASE}/voyages/search/`,
      requestPostData: '{"track":"main"}',
      responseBody: {
        voyages: [{ voyageId: "voy-1", pricing: { currency: "USD", taxIncluded: true } }],
      },
      timestamp: "2024-07-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: `${BASE}/voyages/offers/voy-1/?currency=USD&taxIncluded=true`,
      requestPostData: null,
      responseBody: {
        offers: [{ voyageId: "voy-1", currency: "USD", taxIncluded: true, price: 100 }],
      },
      timestamp: "2024-07-01T00:00:01Z",
    }),
  ];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/voyages/offers/",
  resultsPath: "voyages",
  drillResultsPath: "offers",
  joinFields: ["voyageId"],
};

describe("resolveFoldPlan — single-target structural-guess pair vs declared joinFields override", () => {
  it("resolves the single resolved target's joinFields to the declared voyageId, not the pricing currency/taxIncluded structural guess", () => {
    const actionSteps = buildSingleTargetStructuralGuessDrillDownSteps();

    const plans = resolveFoldPlan(actionSteps, SPEC, null);

    expect(plans).toHaveLength(1);
    const [plan] = plans;
    expect(plan!.targets).toHaveLength(1);
    const [target] = plan!.targets;
    expect(target!.joinFields).toEqual(["voyageId"]);
  });
});
