import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveApplicableFoldPlans } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

const BASE = "https://api.example.com";
const CATALOG_QUERY =
  "query catalogSearch { catalogSearch { items { currency taxIncluded sailingId } } }";
const EMITTED_PRIMARY_ANCHOR = "/graphql::catalogSearch";

/**
 * Mirrors the GraphQL-primary scenario from
 * recon-generate-foldreturn-declared-joinfields-response-only-single-primary-override-runtime-e2e.test.ts,
 * trimmed to only what resolveFoldPlan's structural/spec merge needs: a
 * query-primary with two items each driving their own per-item drill-down at
 * a distinct endpoint, both drills coincidentally sharing currency/
 * taxIncluded request query params (the structural heuristic's guess), while
 * only the response-only sailingId field is declared as the join.
 */
function buildSinglePrimaryDrillDownSteps(): MulticallFixtureStep[] {
  const primary = buildStep("r0", {
    url: `${BASE}/graphql`,
    requestPostData: JSON.stringify({ query: CATALOG_QUERY, variables: {} }),
    responseBody: {
      catalogSearch: {
        items: [
          { currency: "USD", taxIncluded: true, sailingId: "sail-1" },
          { currency: "USD", taxIncluded: true, sailingId: "sail-2" },
        ],
      },
    },
    timestamp: "2026-01-01T00:00:00Z",
  });
  primary.capture.operationName = "catalogSearch";
  primary.capture.query = CATALOG_QUERY;

  const drill1 = buildStep("r1", {
    url: `${BASE}/listings/api/v1/details/1?currency=USD&taxIncluded=true`,
    requestPostData: null,
    responseBody: {
      detail: [{ currency: "USD", taxIncluded: true, sailingId: "sail-1", balance: 100 }],
    },
    timestamp: "2026-01-01T00:00:01Z",
    method: "GET",
  });

  const drill2 = buildStep("r2", {
    url: `${BASE}/listings/api/v1/details/2?currency=USD&taxIncluded=true`,
    requestPostData: null,
    responseBody: {
      detail: [{ currency: "USD", taxIncluded: true, sailingId: "sail-2", balance: 200 }],
    },
    timestamp: "2026-01-01T00:00:02Z",
    method: "GET",
  });

  return [primary, drill1, drill2];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/listings/api/v1/details/",
  resultsPath: "catalogSearch.items",
  drillResultsPath: "detail",
  joinFields: ["sailingId"],
};

describe("resolveApplicableFoldPlans — single-primary getGql/httpClient path honors declared foldReturn.joinFields", () => {
  it("resolves every per-item target's joinFields to the declared sailingId, not the currency+taxIncluded structural guess", () => {
    const actionSteps = buildSinglePrimaryDrillDownSteps();

    const plans = resolveApplicableFoldPlans(actionSteps, SPEC, undefined, EMITTED_PRIMARY_ANCHOR);

    expect(plans).toHaveLength(1);
    const [plan] = plans;
    expect(plan!.targets.length).toBeGreaterThan(0);
    for (const target of plan!.targets) {
      expect(target.joinFields).toEqual(["sailingId"]);
    }
  });
});
