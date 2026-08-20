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
    // The decoy incidentally mentions both field names ("category" in
    // `sort.by`, "priceRange" in `note`) so fieldMatchCount's substring
    // search scores it exactly as high as the facet-bearing capture — this
    // rules out the decoy losing merely because fieldScore already favors
    // the other candidate; facetScore must be what tips the balance.
    const decoy = makeCapture({
      phase: "browse",
      operationName: "SearchProducts",
      query: "query SearchProducts($filters: String) { products(filters: $filters) { id name } }",
      variables: { pagination: { count: 10 }, sort: { by: "category" }, note: "priceRange" },
      responseBody: {
        products: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `Product ${i}` })),
      },
    });
    const decoyRepeat = makeCapture({
      phase: "browse",
      operationName: "SearchProducts",
      query: "query SearchProducts($filters: String) { products(filters: $filters) { id name } }",
      variables: { pagination: { count: 10 }, sort: { by: "category" }, note: "priceRange" },
      responseBody: {
        products: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `Product ${i}` })),
      },
    });
    const facetBearing = makeCapture({
      phase: "filter",
      operationName: "SearchProducts",
      query: "query SearchProducts($filters: String) { products(filters: $filters) { id name } }",
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

  it("reports declared filter variables that are never populated across any candidate", () => {
    const query =
      "query productSearch_Listings($filters: String, $qualifiers: String, $sort: SortInput, $pagination: PaginationInput) { listings { id } }";
    const first = makeCapture({
      operationName: "productSearch_Listings",
      query,
      variables: { sort: { by: "RECOMMENDED" }, pagination: { count: 10, skip: 0 } },
    });
    const second = makeCapture({
      operationName: "productSearch_Listings",
      query,
      variables: {
        sort: { by: "RECOMMENDED" },
        pagination: { count: 10, skip: 10 },
        filters: null,
        qualifiers: "",
      },
    });

    const result = selectPrimaryGraphQLOperation([first, second], [], EMPTY_VOCABULARY);

    expect(result?.unpopulatedDeclaredVariables).toEqual(["filters", "qualifiers"]);
  });

  it("omits a declared filter variable when some candidate actually populates it", () => {
    const query =
      "query productSearch_Listings($filters: String, $qualifiers: String, $sort: SortInput) { listings { id } }";
    const unfiltered = makeCapture({
      operationName: "productSearch_Listings",
      query,
      variables: { sort: { by: "RECOMMENDED" } },
    });
    const filtered = makeCapture({
      operationName: "productSearch_Listings",
      query,
      variables: { sort: { by: "RECOMMENDED" }, filters: "neighborhood:Downtown" },
    });

    const result = selectPrimaryGraphQLOperation([unfiltered, filtered], [], EMPTY_VOCABULARY);

    expect(result?.unpopulatedDeclaredVariables).toEqual(["qualifiers"]);
  });

  it("never selects a third-party-host candidate over a lower-scoring own-backend candidate", () => {
    const thirdParty = makeCapture({
      url: "https://analytics.thirdparty.com/graphql",
      phase: "filter",
      operationName: "SearchProducts",
      query:
        "query SearchProducts($neighborhood: String) { products(neighborhood: $neighborhood) { id name } }",
      variables: { neighborhood: "Downtown" },
      responseBody: {
        products: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `Product ${i}` })),
      },
    });
    const ownBackend = makeCapture({
      url: "https://example.com/graphql",
      phase: "home",
      operationName: "PageChrome",
      query: "query PageChrome { nav { items } }",
      responseBody: { nav: { items: [] } },
    });

    const captures = [thirdParty, ownBackend];
    const flowSteps = [
      { step: "select 'Downtown' from the Neighborhood dropdown", payloadField: "neighborhood" },
    ];

    const result = selectPrimaryGraphQLOperation(
      captures,
      flowSteps,
      EMPTY_VOCABULARY,
      process.env,
      ["example.com"],
      null
    );

    expect(result?.capture).toBe(ownBackend);
  });

  it("groups operationName-null captures sharing an endpoint and parsed inline query name for recurrence credit", () => {
    // Every capture omits operationName, as real facet-bearing inline
    // documents do, and no flowSteps/facet signal is supplied — recurrence
    // is the only signal that can distinguish these two same-size,
    // same-phase candidates, so the recurring one must come from the
    // endpoint + the `query CruisesSearchResults(...)` name parsed out of
    // the body, not from operationName equality (which is null on every
    // candidate here).
    const repeatedNullOp = Array.from({ length: 4 }, (_, i) =>
      makeCapture({
        phase: "filter",
        operationName: null,
        query:
          "query CruisesSearchResults($destination: String) { cruises(destination: $destination) { id } }",
        variables: { destination: "Caribbean" },
        responseBody: { cruises: [{ id: i }] },
      })
    );
    const nonRecurringDecoy = makeCapture({
      phase: "filter",
      operationName: null,
      query: "query PageChrome { nav { items } }",
      responseBody: { cruises: [{ id: 9 }] },
    });

    const result = selectPrimaryGraphQLOperation(
      [nonRecurringDecoy, ...repeatedNullOp],
      [],
      EMPTY_VOCABULARY
    );

    expect(result?.capture.operationName).toBeNull();
    expect(result?.capture.query).toContain("CruisesSearchResults");
  });

  it("does not credit operationName-null captures with different parsed query names as recurring together", () => {
    // Same endpoint, same null operationName, but two distinct underlying
    // queries — grouping must key on the parsed name too, not endpoint alone.
    const facetQuery = makeCapture({
      phase: "filter",
      operationName: null,
      query:
        "query CruisesSearchResults($destination: String) { cruises(destination: $destination) { id } }",
      variables: { destination: "Caribbean" },
      responseBody: { cruises: [{ id: 1 }] },
    });
    const unrelatedQuery = makeCapture({
      phase: "browse",
      operationName: null,
      query: "query PageChrome { nav { items } }",
      responseBody: { nav: { items: Array.from({ length: 200 }, (_, i) => ({ id: i })) } },
    });

    const flowSteps = [
      { step: "select 'Caribbean' from the Destination dropdown", payloadField: "destination" },
    ];
    const result = selectPrimaryGraphQLOperation(
      [unrelatedQuery, facetQuery],
      flowSteps,
      EMPTY_VOCABULARY
    );

    expect(result?.capture).toBe(facetQuery);
  });

  it("returns null when every candidate is off-host", () => {
    const thirdParty = makeCapture({
      url: "https://analytics.thirdparty.com/graphql",
    });

    const result = selectPrimaryGraphQLOperation(
      [thirdParty],
      [],
      EMPTY_VOCABULARY,
      process.env,
      ["example.com"],
      null
    );

    expect(result).toBeNull();
  });
});
