import { describe, expect, it } from "vitest";

import { emitContractTs } from "@/scripts/recon-generate";

/**
 * Locks in the navigateTo-facet-into-array-variable splice end-to-end
 * through emitContractTs — spliceFacetsIntoArrayVariable and its wiring
 * into renderGqlVariablesExpr/flowSteps had no test exercising the full
 * generator path, only the string-variable grammar siblings.
 */
const BASE_OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { id: "abc", active: true },
  gql: true,
  gqlQuery: "query Widgets($ids: [String!]) { widgets(ids: $ids) { id } }",
  gqlOperationName: "Widgets",
  endpointPath: "/api/graphql",
  auxFiles: [],
};

describe("spliceFacetsIntoArrayVariable (via emitContractTs end-to-end)", () => {
  it("splices a navigateTo facet literal into an array-valued gqlVariables element", () => {
    const contract = emitContractTs({
      ...BASE_OPTS,
      gqlVariables: { ids: ["widget-x;filterId=urlFriendlyId", "widget-static"] },
      flowSteps: [
        { step: "navigate to widget", navigateTo: "/catalog#widget-x", payloadField: "slug" },
      ],
    });

    expect(contract).toContain("`${payload.slug};filterId=urlFriendlyId`");
    expect(contract).toContain(JSON.stringify("widget-static"));
  });

  it("leaves the array untouched (falls back to JSON.stringify) when no facet matches", () => {
    const contract = emitContractTs({
      ...BASE_OPTS,
      gqlVariables: { ids: ["unrelated-item"] },
      flowSteps: [
        { step: "navigate to widget", navigateTo: "/catalog#widget-x", payloadField: "slug" },
      ],
    });

    expect(contract).toContain(JSON.stringify(["unrelated-item"]));
  });
});
