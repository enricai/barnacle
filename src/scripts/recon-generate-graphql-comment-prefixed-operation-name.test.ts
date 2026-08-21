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

describe("comment-prefixed GraphQL operation-name/variable parsing", () => {
  it("groups a `#`-comment-prefixed capture with its named repeats instead of falling back to anonymous", () => {
    const commentPrefixed = makeCapture({
      phase: "filter",
      operationName: null,
      query:
        "# CruisesSearchResults\nquery CruisesSearchResults($filters: String) { results(filters: $filters) { id } }",
      variables: { filters: "caribbean" },
    });
    const namedRepeats = Array.from({ length: 4 }, (_, i) =>
      makeCapture({
        phase: "filter",
        operationName: null,
        query: "query CruisesSearchResults($filters: String) { results(filters: $filters) { id } }",
        variables: { filters: "caribbean" },
        responseBody: { results: [{ id: i }] },
      })
    );

    const result = selectPrimaryGraphQLOperation(
      [commentPrefixed, ...namedRepeats],
      [],
      EMPTY_VOCABULARY
    );

    expect(result?.capture.query).toContain("CruisesSearchResults");
  });
});
