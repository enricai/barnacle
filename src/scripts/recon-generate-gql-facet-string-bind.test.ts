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
  gqlQuery: "query catalogSearch_Products($filters: String) { products { id } }",
  endpointPath: "/graphql",
  auxFiles: [],
};

describe("emitContractTs — GraphQL string-variable facet correlation", () => {
  it("splices payload.<Field> into the correlated facet's value slot inside a delimited filters string", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gqlOperationName: "catalogSearch_Products",
      gqlVariables: { filters: "category:widgets|priceRange:10~50" },
      payloadFieldNames: new Set(["Category"]),
    });

    expect(source).toContain("filters: `category:$" + "{payload.Category}|priceRange:10~50`");
  });

  it("leaves an unmatched facet string untouched (JSON.stringify fallback)", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gqlOperationName: "catalogSearch_Products",
      gqlVariables: { filters: "brand:acme|priceRange:10~50" },
      payloadFieldNames: new Set(["Category"]),
    });

    expect(source).toContain('filters: "brand:acme|priceRange:10~50"');
  });

  it("leaves a non-facet-shaped opaque string untouched", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gqlOperationName: "catalogSearch_Products",
      gqlVariables: { token: "abc123opaque" },
      payloadFieldNames: new Set(["Category"]),
    });

    expect(source).toContain('token: "abc123opaque"');
  });

  it("still prefers top-level key correlation over string-facet correlation", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gqlOperationName: "catalogSearch_Products",
      gqlVariables: { category: "widgets" },
      payloadFieldNames: new Set(["Category"]),
    });

    expect(source).toContain("category: payload.Category");
  });
});
