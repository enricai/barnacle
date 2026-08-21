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
  it("groups operationName:null captures by endpoint + parsed query name so the real, frequently-recurring filtered search wins purely on recurrence over a less-recurrent named decoy", () => {
    // The decoy incidentally mentions both field names ("category" in
    // `sort.by`, "priceRange" in `note`) and is a larger, non-home-phase
    // response, so it ties the filtered-search group on fieldScore,
    // phaseScore, and beats it on sizeScore. facetScore is 0 for the decoy
    // (its variables aren't a spliceable string field) but 1 for the group.
    // With those signals fixed, only recurrenceScore can decide the winner:
    // an ungrouped operationName:null capture (recurrenceScore hardcoded to
    // 0) would let the twice-recurring named decoy win; grouped by endpoint
    // + parsed query name, the three-times-recurring filtered-search group
    // outscores it instead.
    const decoy = makeCapture({
      phase: "browse",
      operationName: "PageChrome",
      query: "query PageChrome { nav { items } }",
      variables: { pagination: { count: 10 }, sort: { by: "category" }, note: "priceRange" },
      responseBody: {
        nav: Array.from({ length: 200 }, (_, i) => ({ id: i, label: `Item ${i}` })),
      },
    });
    const decoyRepeat = makeCapture({
      phase: "browse",
      operationName: "PageChrome",
      query: "query PageChrome { nav { items } }",
      variables: { pagination: { count: 10 }, sort: { by: "category" }, note: "priceRange" },
      responseBody: {
        nav: Array.from({ length: 200 }, (_, i) => ({ id: i, label: `Item ${i}` })),
      },
    });

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

    const captures = [decoy, decoyRepeat, filteredSearchA, filteredSearchB, filteredSearchC];
    const flowSteps = [
      { step: "select 'widgets' from the Category dropdown", payloadField: "category" },
      { step: "select '10~50' from the Price Range dropdown", payloadField: "priceRange" },
    ];

    const result = selectPrimaryGraphQLOperation(captures, flowSteps, EMPTY_VOCABULARY);

    expect([filteredSearchA, filteredSearchB, filteredSearchC]).toContain(result?.capture);
  });

  it("groups a `#`-comment-prefixed operationName:null capture with its uncommented named repeats instead of leaving it as an ungrouped singleton", () => {
    // No flowSteps/facet-shaped variables here, so fieldScore and facetScore
    // are 0 for every candidate, phase and response size are identical across
    // all three, and recurrenceScore (weight 0.15) is the only score
    // component that can differ — making it decisive. If the comment line
    // defeats the operation-name regex, `commentPrefixed` parses to
    // `null` and falls back to the "anonymous" group alone (recurrenceScore
    // 0.5 vs. the group's 1), so `namedRepeat`/`namedRepeat2` would outscore
    // and win instead of tying with (and losing the tiebreak to, since it's
    // listed first) `commentPrefixed`.
    const commentPrefixed = makeCapture({
      phase: "filter",
      operationName: null,
      query:
        "# CruisesSearchResults\nquery CruisesSearchResults($filters: String) { results(filters: $filters) { id } }",
      variables: {},
      responseBody: { results: [{ id: 0 }] },
    });
    const namedRepeat = makeCapture({
      phase: "filter",
      operationName: null,
      query: "query CruisesSearchResults($filters: String) { results(filters: $filters) { id } }",
      variables: { filters: "caribbean" },
      responseBody: { results: [{ id: 1 }] },
    });
    const namedRepeat2 = makeCapture({
      phase: "filter",
      operationName: null,
      query: "query CruisesSearchResults($filters: String) { results(filters: $filters) { id } }",
      variables: { filters: "caribbean" },
      responseBody: { results: [{ id: 2 }] },
    });

    const captures = [commentPrefixed, namedRepeat, namedRepeat2];
    const result = selectPrimaryGraphQLOperation(captures, [], EMPTY_VOCABULARY);

    expect(result?.capture).toBe(commentPrefixed);
  });
});
