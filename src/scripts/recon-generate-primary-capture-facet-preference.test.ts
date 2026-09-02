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

function gqlCapture(overrides: Partial<Capture>): Capture {
  return makeCapture({
    operationName: "catalogSearch_Items",
    query:
      "query catalogSearch_Items($filters: String) { catalogSearch(filters: $filters) { items { id name } } }",
    ...overrides,
  });
}

describe("selectPrimaryGraphQLOperation facet preference", () => {
  it("prefers a facet-bearing capture over a same-operation candidate that wins on size and recurrence alone", () => {
    // The unfiltered decoy incidentally mentions both field names ("category"
    // in `sort.by`, "priceRange" in `note`) so fieldMatchCount's substring
    // search scores it exactly as high as the facet-bearing capture — this
    // rules out the decoy losing merely because fieldScore already favors
    // the other candidate; facetScore must be what tips the balance.
    const unfiltered = gqlCapture({
      variables: { pagination: { count: 24 }, sort: { by: "category" }, note: "priceRange" },
      responseBody: {
        catalogSearch: {
          items: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `Item ${i}` })),
        },
      },
    });
    const unfilteredRepeatA = gqlCapture({
      variables: { pagination: { count: 24 }, sort: { by: "category" }, note: "priceRange" },
      responseBody: {
        catalogSearch: {
          items: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `Item ${i}` })),
        },
      },
    });
    const unfilteredRepeatB = gqlCapture({
      variables: { pagination: { count: 24 }, sort: { by: "category" }, note: "priceRange" },
      responseBody: {
        catalogSearch: {
          items: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `Item ${i}` })),
        },
      },
    });
    const facetBearing = gqlCapture({
      phase: "filter",
      variables: { filters: "category:kitchen|priceRange:10~50" },
      responseBody: {
        catalogSearch: { items: [{ id: 1, name: "Item 1" }] },
      },
    });

    const captures = [unfiltered, unfilteredRepeatA, unfilteredRepeatB, facetBearing];
    const flowSteps = [
      { step: "select 'kitchen' from the Category dropdown", payloadField: "category" },
      { step: "select '10~50' from the Price Range dropdown", payloadField: "priceRange" },
    ];

    const result = selectPrimaryGraphQLOperation(captures, flowSteps, EMPTY_VOCABULARY);

    expect(result?.capture).toBe(facetBearing);
  });

  it("still returns the highest composite-score winner when no candidate is facet-bearing", () => {
    const pageLoad = gqlCapture({
      phase: "home",
      operationName: "PageChrome",
      query: "query PageChrome { nav { items } }",
      variables: null,
      responseBody: { nav: { items: [] } },
    });
    const catalogSearch = gqlCapture({
      variables: { pagination: { count: 24 } },
      responseBody: {
        catalogSearch: {
          items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `Item ${i}` })),
        },
      },
    });

    const captures = [pageLoad, catalogSearch];
    const flowSteps = [
      { step: "select 'kitchen' from the Category dropdown", payloadField: "category" },
    ];

    const result = selectPrimaryGraphQLOperation(captures, flowSteps, EMPTY_VOCABULARY);

    expect(result?.capture).toBe(catalogSearch);
  });

  it("prefers a facet-spliceable candidate over a larger, more-recurring non-facet decoy on the same endpoint", () => {
    // The decoy incidentally mentions "category" too, so fieldScore ties with
    // the facet candidate — without a hard facet preference the decoy still
    // wins on sizeScore + phaseScore + recurrenceScore alone (0.80 composite
    // vs. the facet candidate's ~0.73), which is exactly the failure this
    // subtask closes.
    const decoyA = gqlCapture({
      operationName: "FilterOptionsQuery",
      query: "query FilterOptionsQuery { filterOptions { category values } }",
      variables: { context: "category" },
      responseBody: {
        filterOptions: Array.from({ length: 200 }, (_, i) => ({ id: i, label: `Option ${i}` })),
      },
    });
    const decoyRest = Array.from({ length: 4 }, () => ({ ...decoyA }));
    const facetBearing = gqlCapture({
      operationName: "catalogSearch_Items",
      variables: { filters: "category:kitchen" },
      responseBody: { catalogSearch: { items: [{ id: 1, name: "Item 1" }] } },
    });

    const captures = [decoyA, ...decoyRest, facetBearing];
    const flowSteps = [
      { step: "select 'kitchen' from the Category dropdown", payloadField: "category" },
    ];

    const result = selectPrimaryGraphQLOperation(captures, flowSteps, EMPTY_VOCABULARY);

    expect(result?.capture).toBe(facetBearing);
  });

  it("prefers an own-backend facet-bearing operationName-null query over both a same-host non-facet named query and a higher-volume third-party host", () => {
    const ownBackendFacetBearing = makeCapture({
      phase: "filter",
      url: "https://own-backend.example.com/graphql",
      operationName: null,
      query:
        "query catalogSearch_Items($filters: String) { catalogSearch(filters: $filters) { items { id name } } }",
      variables: { filters: "category:kitchen" },
      responseBody: { catalogSearch: { items: [{ id: 1, name: "Item 1" }] } },
    });
    const ownBackendNamedNonFacet = gqlCapture({
      url: "https://own-backend.example.com/graphql",
      variables: { pagination: { count: 24 } },
      responseBody: {
        catalogSearch: {
          items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `Item ${i}` })),
        },
      },
    });
    const thirdPartyDecoy = makeCapture({
      url: "https://tracker.thirdparty-sdk.example/collect",
      operationName: "trackerCollect",
      query: "query trackerCollect { events { id } }",
      variables: null,
      responseBody: { events: Array.from({ length: 500 }, (_, i) => ({ id: i })) },
    });

    const captures = [
      ...Array.from({ length: 20 }, () => ({ ...thirdPartyDecoy })),
      ownBackendNamedNonFacet,
      ownBackendFacetBearing,
    ];
    const flowSteps = [
      { step: "select 'kitchen' from the Category dropdown", payloadField: "category" },
    ];

    const result = selectPrimaryGraphQLOperation(
      captures,
      flowSteps,
      EMPTY_VOCABULARY,
      process.env,
      ["own-backend.example.com"]
    );

    expect(result?.capture).toBe(ownBackendFacetBearing);
  });

  it("prefers the capture that splices more caller facets over a same-operation capture with a larger response that splices fewer facets", () => {
    // oneFacetCapture's `note` field incidentally mentions "priceRange" so
    // fieldMatchCount ties both candidates at 2/2 — this isolates facetScore
    // as the only signal that can distinguish "splices 1 facet" from
    // "splices 2 facets"; without it sizeScore's larger response wins.
    const twoFacetCapture = gqlCapture({
      variables: { filters: "category:kitchen|priceRange:10~50" },
      responseBody: { catalogSearch: { items: [{ id: 1, name: "Item 1" }] } },
    });
    const oneFacetCapture = gqlCapture({
      variables: { filters: "category:kitchen", note: "priceRange" },
      responseBody: {
        catalogSearch: {
          items: Array.from({ length: 3 }, (_, i) => ({ id: i, name: `Item ${i}` })),
        },
      },
    });

    const captures = [oneFacetCapture, twoFacetCapture];
    const flowSteps = [
      { step: "select 'kitchen' from the Category dropdown", payloadField: "category" },
      { step: "select '10~50' from the Price Range dropdown", payloadField: "priceRange" },
    ];

    const result = selectPrimaryGraphQLOperation(captures, flowSteps, EMPTY_VOCABULARY);

    expect(result?.capture).toBe(twoFacetCapture);
  });
});
