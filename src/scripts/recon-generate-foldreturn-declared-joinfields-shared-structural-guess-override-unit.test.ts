import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveFoldPlan } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

const BASE = "https://api.example.com";

/**
 * Mirrors the fixture shape from
 * recon-generate-foldreturn-declared-joinfields-single-primary-anchor-unit.test.ts,
 * isolating resolveFoldPlan directly instead of going through
 * resolveApplicableFoldPlans: a query-primary with two items, each driving
 * its own per-item drill-down at a DISTINCT endpoint identity. Both drills
 * coincidentally share the same `priceSummary.currency`/
 * `priceSummary.taxIncluded` request query params (the structural
 * heuristic's shared guess), while only the response-only, per-item-unique
 * `sessionId` field is declared as the join. buildFoldPlanFromSpec's
 * freshest-first scan resolves and `break`s on only ONE drill endpoint per
 * call, so mergeSpecPlanOntoSamePrimary must resolve the declared override
 * independently for EACH structural target -- keyed by its own drill
 * endpoint -- or every target past the first keeps its structural guess.
 */
function buildSharedStructuralGuessDrillDownSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: `${BASE}/sessions/search/`,
      requestPostData: '{"track":"main"}',
      responseBody: {
        sessions: [
          { sessionId: "sess-1", priceSummary: { currency: "USD", taxIncluded: true } },
          { sessionId: "sess-2", priceSummary: { currency: "USD", taxIncluded: true } },
        ],
      },
      timestamp: "2024-06-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: `${BASE}/sessions/pricing/sess-1/?currency=USD&taxIncluded=true`,
      requestPostData: null,
      responseBody: {
        candidates: [{ sessionId: "sess-1", currency: "USD", taxIncluded: true, price: 100 }],
      },
      timestamp: "2024-06-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: `${BASE}/sessions/pricing/sess-2/?currency=USD&taxIncluded=true`,
      requestPostData: null,
      responseBody: {
        candidates: [{ sessionId: "sess-2", currency: "USD", taxIncluded: true, price: 200 }],
      },
      timestamp: "2024-06-01T00:00:02Z",
    }),
  ];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/sessions/pricing/",
  resultsPath: "sessions",
  drillResultsPath: "candidates",
  joinFields: ["sessionId"],
};

describe("resolveFoldPlan — nested structural-guess pair vs declared joinFields override on every per-item target", () => {
  it("resolves every per-item target's joinFields to the declared sessionId, not the shared priceSummary currency/taxIncluded structural guess", () => {
    const actionSteps = buildSharedStructuralGuessDrillDownSteps();

    const plans = resolveFoldPlan(actionSteps, SPEC, null);

    expect(plans).toHaveLength(1);
    const [plan] = plans;
    expect(plan!.targets).toHaveLength(2);
    for (const target of plan!.targets) {
      expect(target.joinFields).toEqual(["sessionId"]);
    }
  });
});
