import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

const BASE_OPTS = {
  siteId: "listings-site",
  pascal: "ListingsSite",
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
      gqlQuery: "query ListingSearchListings($metro: String, $beds: Int) { listings { id } }",
      gqlOperationName: "ListingSearchListings",
      gqlVariables: { metro: "x", beds: 7 },
      payloadFieldNames: new Set(["metro", "beds"]),
    });

    // (a) operationName is the selected capture's own, not a siteId-derived placeholder
    expect(source).toContain('getGql(context.baseUrl)("ListingSearchListings"');
    // (b) the hardcoded siteId-derived operation name literal is gone
    expect(source).not.toContain(`$${"{pascal}"}Search`);
    expect(source).not.toContain('"ListingsSiteSearch"');
    // (c) variables are bound to the flow's payloadFields, replacing the hardcoded { q: payload.query }
    expect(source).toContain("metro: payload.metro");
    expect(source).toContain("beds: payload.beds");
    expect(source).not.toContain("{ q: payload.query }");
    // (d) the QUERY const and getGql endpoint still come from that same selected capture
    expect(source).toContain(
      "const LISTINGSSITE_QUERY = `query ListingSearchListings($metro: String, $beds: Int) { listings { id } }`;"
    );
    expect(source).toContain(
      'getGql(context.baseUrl)("ListingSearchListings", LISTINGSSITE_QUERY, { metro: payload.metro, beds: payload.beds })'
    );
    expect(source).toContain(`endpoint: \`\${baseUrl}/graphql\``);
  });
});
