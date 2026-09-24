import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveFoldPlan } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

const BASE = "https://api.example.com";

/**
 * A search -> per-item drill-down pair where the drill endpoint is captured
 * TWICE (`r1`, a plain lookup; `r2`, a "refresh" re-query) at the SAME
 * endpoint identity. The structural heuristic threads the nested
 * `priceSummary.currency`/`priceSummary.taxIncluded` pair from the primary
 * item's own fields into both drill requests' query params, resolving its
 * OWN guessed `joinFields` to that compound pair. A declared
 * `foldReturn.joinFields: ["sessionId"]` names a field the heuristic could
 * never infer -- `sessionId` never threads into any request, appearing only
 * in the primary and drill response bodies -- so the declared field must
 * still win as the resolved target's `joinFields`, not be silently shadowed
 * by the heuristic's own inferred nested pair.
 */
function buildSharedStructuralGuessDrillDownSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: `${BASE}/listings/search/`,
      requestPostData: '{"city":"nyc"}',
      responseBody: {
        listings: [
          {
            code: "hz-1",
            priceSummary: { currency: "USD", taxIncluded: true },
            sessionId: "sess-77",
          },
        ],
      },
      timestamp: "2026-01-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: `${BASE}/listings/details/hz-1/?currency=USD&taxIncluded=true`,
      requestPostData: '{"lookup":true}',
      responseBody: {
        detail: [
          {
            code: "hz-1",
            priceSummary: { currency: "USD", taxIncluded: true },
            sessionId: "sess-77",
            balance: 100,
          },
        ],
      },
      timestamp: "2026-01-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: `${BASE}/listings/details/hz-1/?currency=USD&taxIncluded=true&refresh=true`,
      requestPostData: '{"lookup":true,"refresh":true}',
      responseBody: {
        detail: [
          {
            code: "hz-1",
            priceSummary: { currency: "USD", taxIncluded: true },
            sessionId: "sess-77",
            balance: 150,
          },
        ],
      },
      timestamp: "2026-01-01T00:00:02Z",
    }),
  ];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/listings/details/",
  resultsPath: "listings",
  drillResultsPath: "detail",
  joinFields: ["sessionId"],
};

describe("resolveFoldPlan — nested structural-guess pair vs declared joinFields override", () => {
  it("resolves the single target's joinFields to the declared sessionId, not the priceSummary currency/taxIncluded structural guess", () => {
    const actionSteps = buildSharedStructuralGuessDrillDownSteps();

    const plans = resolveFoldPlan(actionSteps, SPEC, null);

    expect(plans).toHaveLength(1);
    const [plan] = plans;
    expect(plan!.targets).toHaveLength(1);
    const [target] = plan!.targets;
    expect(target!.joinFields).toEqual(["sessionId"]);
  });
});
