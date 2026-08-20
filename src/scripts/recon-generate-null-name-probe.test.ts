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

describe("probe: operationName-less recurrence grouping", () => {
  it("prefers a frequently-repeated null-operationName query over a rarer named decoy", () => {
    const filteredResults = Array.from({ length: 5 }, (_, i) =>
      makeCapture({
        phase: "filter",
        operationName: null,
        query:
          "query GetFilteredResults($category: String) { results(category: $category) { id } }",
        variables: { category: "shoes" },
        responseBody: { results: [{ id: i }] },
      })
    );
    const decoy = makeCapture({
      phase: "filter",
      operationName: "Decoy",
      query: "query Decoy { decoy { id } }",
      responseBody: { decoy: { id: 1 } },
    });

    const result = selectPrimaryGraphQLOperation([...filteredResults, decoy], [], EMPTY_VOCABULARY);

    expect(result?.capture.operationName).toBeNull();
    expect(result?.capture.query).toContain("GetFilteredResults");
  });
});
