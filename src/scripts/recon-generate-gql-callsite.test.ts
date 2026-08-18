import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

const BASE_OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { id: "abc", active: true },
  gql: true,
  gqlQuery: "query cruiseSearch_Cruises($destination: String) { cruises { id } }",
  endpointPath: "/graphql",
  auxFiles: [],
};

describe("emitContractTs — GraphQL getGql() call site", () => {
  it("uses the selected capture's own operationName and binds correlated variables to payload fields", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gqlOperationName: "cruiseSearch_Cruises",
      gqlVariables: { destination: "Miami", nights: 7, ship: "Oasis", departurePort: "Miami" },
      payloadFieldNames: new Set(["Destination", "Nights", "Ship", "DeparturePort"]),
    });

    expect(source).toContain('getGql(context.baseUrl)("cruiseSearch_Cruises"');
    expect(source).toContain("destination: payload.Destination");
    expect(source).toContain("nights: payload.Nights");
    expect(source).toContain("ship: payload.Ship");
    expect(source).toContain("departurePort: payload.DeparturePort");
    expect(source).not.toContain(`$${"{pascal}"}Search`);
    expect(source).not.toContain("{ q: payload.query }");
  });

  it("falls back to the literal captured value when a variable key does not correlate with any payload field", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gqlOperationName: "cruiseSearch_Cruises",
      gqlVariables: { locale: "en-US" },
      payloadFieldNames: new Set(["Destination"]),
    });

    expect(source).toContain('locale: "en-US"');
  });

  it("emits byte-identical output to the hardcoded form when gqlOperationName/gqlVariables are unset", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gqlOperationName: null,
      gqlVariables: null,
    });

    expect(source).toContain(
      'getGql(context.baseUrl)("TestSiteSearch", TESTSITE_QUERY, { q: payload.query })'
    );
  });
});
