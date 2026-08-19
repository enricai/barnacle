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
  gqlQuery: "query listingSearch_Listings($metro: String) { listings { id } }",
  endpointPath: "/graphql",
  auxFiles: [],
};

describe("emitContractTs — GraphQL getGql() call site", () => {
  it("uses the selected capture's own operationName and binds correlated variables to payload fields", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gqlOperationName: "listingSearch_Listings",
      gqlVariables: { metro: "Downtown", beds: 7, propertyType: "Condo", neighborhood: "Downtown" },
      payloadFieldNames: new Set(["Metro", "Beds", "PropertyType", "Neighborhood"]),
    });

    expect(source).toContain('getGql(context.baseUrl)("listingSearch_Listings"');
    expect(source).toContain("metro: payload.Metro");
    expect(source).toContain("beds: payload.Beds");
    expect(source).toContain("propertyType: payload.PropertyType");
    expect(source).toContain("neighborhood: payload.Neighborhood");
    expect(source).not.toContain(`$${"{pascal}"}Search`);
    expect(source).not.toContain("{ q: payload.query }");
  });

  it("falls back to the literal captured value when a variable key does not correlate with any payload field", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gqlOperationName: "listingSearch_Listings",
      gqlVariables: { locale: "en-US" },
      payloadFieldNames: new Set(["Metro"]),
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
