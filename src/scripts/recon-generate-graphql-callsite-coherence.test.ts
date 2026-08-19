import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

const BASE_OPTS = {
  siteId: "cruise-site",
  pascal: "CruiseSite",
  baseUrl: "https://example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { id: "abc", active: true },
  gql: true,
  endpointPath: "/graphql",
  auxFiles: [],
};

describe("emitContractTs — getGql() call-site coherence with the selected capture", () => {
  it("emits the selected capture's operationName/variables and keeps the QUERY const/endpoint bound to that same capture", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gqlQuery: "query CruiseSearchCruises($destination: String, $nights: Int) { cruises { id } }",
      gqlOperationName: "CruiseSearchCruises",
      gqlVariables: { destination: "x", nights: 7 },
      payloadFieldNames: new Set(["destination", "nights"]),
    });

    // (a) operationName is the selected capture's own, not a siteId-derived placeholder
    expect(source).toContain('getGql(context.baseUrl)("CruiseSearchCruises"');
    // (b) the hardcoded siteId-derived operation name literal is gone
    expect(source).not.toContain(`$${"{pascal}"}Search`);
    expect(source).not.toContain('"CruiseSiteSearch"');
    // (c) variables are bound to the flow's payloadFields, replacing the hardcoded { q: payload.query }
    expect(source).toContain("destination: payload.destination");
    expect(source).toContain("nights: payload.nights");
    expect(source).not.toContain("{ q: payload.query }");
    // (d) the QUERY const and getGql endpoint still come from that same selected capture
    expect(source).toContain(
      "const CRUISESITE_QUERY = `query CruiseSearchCruises($destination: String, $nights: Int) { cruises { id } }`;"
    );
    expect(source).toContain(
      'getGql(context.baseUrl)("CruiseSearchCruises", CRUISESITE_QUERY, { destination: payload.destination, nights: payload.nights })'
    );
    expect(source).toContain(`endpoint: \`\${baseUrl}/graphql\``);
  });
});
