import { describe, expect, it } from "vitest";
import { EMPTY_VOCABULARY } from "@/recon/vocabulary";
import { selectPrimaryGraphQLOperation } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

function makeCapture(overrides: Partial<Capture>): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "browse",
    method: "POST",
    url: "https://example.com/graphql",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {},
    operationName: null,
    query: "query GetFacets { facets { id } }",
    variables: null,
    decodedParams: null,
    ...overrides,
  };
}

describe("selectPrimaryGraphQLOperation", () => {
  it("picks the large facet-correlated query over the small chronologically-first page-load query", () => {
    const pageLoad = makeCapture({
      phase: "home",
      operationName: "PageChrome",
      query: "query PageChrome { nav { items } }",
      responseBody: { nav: { items: [] } },
    });
    const facetSearch = makeCapture({
      phase: "filter",
      operationName: "SearchProducts",
      query:
        "query SearchProducts($neighborhood: String) { products(neighborhood: $neighborhood) { id name } }",
      variables: { neighborhood: "Downtown" },
      responseBody: {
        products: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `Product ${i}` })),
      },
    });

    const captures = [pageLoad, facetSearch];
    const flowSteps = [
      { step: "select 'Downtown' from the Neighborhood dropdown", payloadField: "neighborhood" },
    ];

    const result = selectPrimaryGraphQLOperation(captures, flowSteps, EMPTY_VOCABULARY);

    expect(result?.capture).toBe(facetSearch);
    expect(result?.endpointPath).toBe("/graphql");
  });

  it("returns null when every candidate is a mutation", () => {
    const mutation = makeCapture({
      query: "mutation AddToCart($id: ID!) { addToCart(id: $id) { ok } }",
    });
    const result = selectPrimaryGraphQLOperation([mutation], [], EMPTY_VOCABULARY);
    expect(result).toBeNull();
  });

  it("returns null when there are no query captures", () => {
    const nonGraphql = makeCapture({ query: null });
    const result = selectPrimaryGraphQLOperation([nonGraphql], [], EMPTY_VOCABULARY);
    expect(result).toBeNull();
  });

  it("uses the winning capture's own URL pathname, not the first candidate's", () => {
    const first = makeCapture({
      url: "https://example.com/graphql/page-chrome",
      phase: "home",
      operationName: "PageChrome",
      query: "query PageChrome { nav { items } }",
      responseBody: {},
    });
    const winner = makeCapture({
      url: "https://example.com/graphql/search",
      phase: "filter",
      operationName: "SearchProducts",
      query:
        "query SearchProducts($neighborhood: String) { products(neighborhood: $neighborhood) { id } }",
      variables: { neighborhood: "Downtown" },
      responseBody: { products: Array.from({ length: 30 }, (_, i) => ({ id: i })) },
    });

    const result = selectPrimaryGraphQLOperation(
      [first, winner],
      [{ step: "select 'Downtown' from the Neighborhood dropdown", payloadField: "neighborhood" }],
      EMPTY_VOCABULARY
    );

    expect(result?.endpointPath).toBe("/graphql/search");
  });

  it("prefers a facet-bearing capture over a larger, more recurrent decoy sharing the same operation", () => {
    const decoy = makeCapture({
      phase: "browse",
      operationName: "SearchProducts",
      query:
        "query SearchProducts($filters: String) { products(filters: $filters) { id name } }",
      variables: { pagination: { count: 10 } },
      responseBody: {
        products: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `Product ${i}` })),
      },
    });
    const decoyRepeat = makeCapture({
      phase: "browse",
      operationName: "SearchProducts",
      query:
        "query SearchProducts($filters: String) { products(filters: $filters) { id name } }",
      variables: { pagination: { count: 10 } },
      responseBody: {
        products: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `Product ${i}` })),
      },
    });
    const facetBearing = makeCapture({
      phase: "filter",
      operationName: "SearchProducts",
      query:
        "query SearchProducts($filters: String) { products(filters: $filters) { id name } }",
      variables: { filters: "category:widgets|priceRange:10~50" },
      responseBody: {
        products: Array.from({ length: 5 }, (_, i) => ({ id: i, name: `Product ${i}` })),
      },
    });

    const captures = [decoy, decoyRepeat, facetBearing];
    const flowSteps = [
      { step: "select 'widgets' from the Category dropdown", payloadField: "category" },
      { step: "select '10~50' from the Price Range dropdown", payloadField: "priceRange" },
    ];

    const result = selectPrimaryGraphQLOperation(captures, flowSteps, EMPTY_VOCABULARY);

    expect(result?.capture).toBe(facetBearing);
  });
});
