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

describe("selectPrimaryGraphQLOperation - operationName-less recurrence grouping", () => {
  it("groups operationName:null captures by endpoint + parsed query name so the real, frequently-recurring filtered search wins over a less-recurrent named decoy", () => {
    const query =
      "query FilteredResults($filters: String) { listings(filters: $filters) { id name } }";

    const filteredSearchA = makeCapture({
      phase: "filter",
      operationName: null,
      query,
      variables: { filters: "category:widgets|priceRange:10~50" },
      responseBody: {
        listings: Array.from({ length: 5 }, (_, i) => ({ id: i, name: `Listing ${i}` })),
      },
    });
    const filteredSearchB = makeCapture({
      phase: "filter",
      operationName: null,
      query,
      variables: { filters: "category:widgets|priceRange:10~50" },
      responseBody: {
        listings: Array.from({ length: 5 }, (_, i) => ({ id: i, name: `Listing ${i}` })),
      },
    });
    const filteredSearchC = makeCapture({
      phase: "filter",
      operationName: null,
      query,
      variables: { filters: "category:widgets|priceRange:10~50" },
      responseBody: {
        listings: Array.from({ length: 5 }, (_, i) => ({ id: i, name: `Listing ${i}` })),
      },
    });
    const namedDecoy = makeCapture({
      phase: "browse",
      operationName: "PageChrome",
      query: "query PageChrome { nav { items } }",
      responseBody: {
        nav: Array.from({ length: 200 }, (_, i) => ({ id: i, label: `Item ${i}` })),
      },
    });

    const captures = [namedDecoy, filteredSearchA, filteredSearchB, filteredSearchC];
    const flowSteps = [
      { step: "select 'widgets' from the Category dropdown", payloadField: "category" },
      { step: "select '10~50' from the Price Range dropdown", payloadField: "priceRange" },
    ];

    const result = selectPrimaryGraphQLOperation(captures, flowSteps, EMPTY_VOCABULARY);

    expect(result).not.toBeNull();
    expect([filteredSearchA, filteredSearchB, filteredSearchC]).toContain(result?.capture);
  });
});
