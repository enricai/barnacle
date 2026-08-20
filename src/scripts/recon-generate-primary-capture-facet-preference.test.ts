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
});
