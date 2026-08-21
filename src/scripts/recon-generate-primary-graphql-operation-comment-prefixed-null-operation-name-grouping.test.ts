import { describe, expect, it } from "vitest";
import { EMPTY_VOCABULARY } from "@/recon/vocabulary";
import { selectPrimaryGraphQLOperation } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

function makeCapture(overrides: Partial<Capture>): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "filter",
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

const sharedResponseBody = () => ({
  results: Array.from({ length: 5 }, (_, i) => ({ id: i, name: `Row ${i}` })),
});

describe("selectPrimaryGraphQLOperation - comment-prefixed operationName-less recurrence grouping", () => {
  it("keeps two comment-prefixed, operationName:null operations at the same endpoint in distinct recurrence groups instead of merging them into one anonymous bucket", () => {
    // Every scoring signal except recurrenceScore is pinned identical between
    // the decoy and the real facet-search group (same phase, same facet-
    // spliceable variables shape so both clear the facetCandidates gate, same
    // response size), so recurrenceScore is the sole decider. If
    // operationGroupKey failed to strip the leading comment before calling
    // parsedOperationName, both comment-prefixed, operationName:null groups
    // would collapse onto the same `${endpointPath}::anonymous` key: their
    // counts would merge, recurrenceScore would tie for both, and the reduce
    // over equal scores keeps whichever candidate came first -- the decoy,
    // listed first below -- instead of the genuinely more-recurrent group.
    const decoyQuery = "# PageChrome\nquery PageChrome { nav { items } }";
    const decoy = makeCapture({
      operationName: null,
      query: decoyQuery,
      variables: { filters: "category:aaa|priceRange:bbb" },
      responseBody: sharedResponseBody(),
    });
    const decoyRepeat = makeCapture({
      operationName: null,
      query: decoyQuery,
      variables: { filters: "category:aaa|priceRange:bbb" },
      responseBody: sharedResponseBody(),
    });

    const facetQuery =
      "# FacetSearch\nquery FacetSearch($filters: String) { listings(filters: $filters) { id name } }";
    const facetSearchA = makeCapture({
      operationName: null,
      query: facetQuery,
      variables: { filters: "category:widgets|priceRange:10~50" },
      responseBody: sharedResponseBody(),
    });
    const facetSearchB = makeCapture({
      operationName: null,
      query: facetQuery,
      variables: { filters: "category:widgets|priceRange:10~50" },
      responseBody: sharedResponseBody(),
    });
    const facetSearchC = makeCapture({
      operationName: null,
      query: facetQuery,
      variables: { filters: "category:widgets|priceRange:10~50" },
      responseBody: sharedResponseBody(),
    });

    // Decoy listed first so a tie (the bug's symptom) would resolve to the
    // decoy under reduce's "first wins on equal score" semantics.
    const captures = [decoy, decoyRepeat, facetSearchA, facetSearchB, facetSearchC];
    const flowSteps = [
      { step: "select 'widgets' from the Category dropdown", payloadField: "category" },
      { step: "select '10~50' from the Price Range dropdown", payloadField: "priceRange" },
    ];

    const result = selectPrimaryGraphQLOperation(captures, flowSteps, EMPTY_VOCABULARY);

    expect([facetSearchA, facetSearchB, facetSearchC]).toContain(result?.capture);
  });
});
