import { describe, expect, it } from "vitest";

import { emitContractTs } from "@/scripts/recon-generate";

/**
 * Locks in the top-level scalar / packed-string GraphQL variable facet splice
 * through emitContractTs, so the generated template interpolates the payload
 * field instead of emitting literal text.
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
  gqlQuery: "query Widgets($id: String, $filter: String) { widgets(id: $id) { id } }",
  gqlOperationName: "Widgets",
  endpointPath: "/api/graphql",
  auxFiles: [],
};

const FLOW_STEPS = [
  { step: "navigate to widget", navigateTo: "/catalog#widget-x", payloadField: "slug" },
];

describe("spliceFacetRecurrenceIntoScalarVariable (via emitContractTs)", () => {
  it("binds a top-level scalar variable equal to a facet literal to the payload field", () => {
    const contract = emitContractTs({
      ...BASE_OPTS,
      gqlVariables: { id: "widget-x" },
      flowSteps: FLOW_STEPS,
    });

    expect(contract).toContain("payload.slug");
  });

  it("interpolates the payload field inside a packed key:value string", () => {
    const contract = emitContractTs({
      ...BASE_OPTS,
      gqlVariables: { filter: "kind:widget-x|color:red" },
      flowSteps: FLOW_STEPS,
    });

    expect(contract).toContain("`kind:${payload.slug}|color:red`");
  });
});
