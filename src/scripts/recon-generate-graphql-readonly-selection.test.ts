import { describe, expect, it } from "vitest";
import { EMPTY_VOCABULARY } from "@/recon/vocabulary";
import { selectPrimaryGraphQLOperation } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

function gqlCapture(overrides: Partial<Capture>): Capture {
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

function bodyOfLength(length: number): unknown {
  return { pad: "x".repeat(Math.max(0, length - '{"pad":""}'.length)) };
}

const FLIGHTS_FLOW_STEPS = [
  { step: "select 'MIA' from the Origin dropdown", payloadField: "originPort" },
];

describe("selectPrimaryGraphQLOperation — read-only flow ranking", () => {
  it("selects the facet-matching, re-querying, filter-phase capture over a larger decoy at a different endpoint", () => {
    const decoy = gqlCapture({
      url: "https://example.com/graphql/page-chrome",
      phase: "home",
      operationName: "PageChrome",
      query: "query PageChrome { nav { items } }",
      responseBody: bodyOfLength(1099),
    });
    const nearSizeIrrelevantDecoy = gqlCapture({
      url: "https://example.com/graphql/promo",
      phase: "home",
      operationName: "PromoBanner",
      query: "query PromoBanner { banners { id imageUrl } }",
      responseBody: bodyOfLength(560000),
    });
    const facetMatch = gqlCapture({
      url: "https://example.com/graphql/search",
      phase: "filter",
      operationName: "SearchFlights",
      query: "query SearchFlights($originPort: String) { flights(originPort: $originPort) { id } }",
      variables: { originPort: "MIA" },
      responseBody: bodyOfLength(565648),
    });
    const facetMatchRequery = gqlCapture({
      url: "https://example.com/graphql/search",
      phase: "filter",
      operationName: "SearchFlights",
      query: "query SearchFlights($originPort: String) { flights(originPort: $originPort) { id } }",
      variables: { originPort: "MIA" },
      responseBody: bodyOfLength(565648),
    });

    const captures = [decoy, nearSizeIrrelevantDecoy, facetMatch, facetMatchRequery];
    const result = selectPrimaryGraphQLOperation(captures, FLIGHTS_FLOW_STEPS, EMPTY_VOCABULARY);

    expect(result?.capture).toBe(facetMatch);
    expect(result?.endpointPath).toBe("/graphql/search");
  });

  it("proves size alone is insufficient: the largest response still loses to a smaller facet+phase+requery match", () => {
    const wrongFacetLargest = gqlCapture({
      url: "https://example.com/graphql/page-chrome",
      phase: "home",
      operationName: "PageChrome",
      query: "query PageChrome { nav { items } }",
      responseBody: bodyOfLength(900000),
    });
    const facetMatch = gqlCapture({
      url: "https://example.com/graphql/search",
      phase: "filter",
      operationName: "SearchFlights",
      query: "query SearchFlights($originPort: String) { flights(originPort: $originPort) { id } }",
      variables: { originPort: "MIA" },
      responseBody: bodyOfLength(565648),
    });
    const facetMatchRequery = gqlCapture({
      url: "https://example.com/graphql/search",
      phase: "filter",
      operationName: "SearchFlights",
      query: "query SearchFlights($originPort: String) { flights(originPort: $originPort) { id } }",
      variables: { originPort: "MIA" },
      responseBody: bodyOfLength(565648),
    });

    const captures = [wrongFacetLargest, facetMatch, facetMatchRequery];
    const result = selectPrimaryGraphQLOperation(captures, FLIGHTS_FLOW_STEPS, EMPTY_VOCABULARY);

    expect(result?.capture).not.toBe(wrongFacetLargest);
    expect(result?.capture).toBe(facetMatch);
    expect(result?.endpointPath).toBe("/graphql/search");
  });

  it("excludes non-2xx query captures from ranking even when they would otherwise win", () => {
    const failedFacetMatch = gqlCapture({
      url: "https://example.com/graphql/search",
      status: 500,
      phase: "filter",
      operationName: "SearchFlights",
      query: "query SearchFlights($originPort: String) { flights(originPort: $originPort) { id } }",
      variables: { originPort: "MIA" },
      responseBody: bodyOfLength(900000),
    });
    const onlySuccessfulCandidate = gqlCapture({
      url: "https://example.com/graphql/page-chrome",
      status: 200,
      phase: "home",
      operationName: "PageChrome",
      query: "query PageChrome { nav { items } }",
      responseBody: bodyOfLength(1099),
    });

    const result = selectPrimaryGraphQLOperation(
      [failedFacetMatch, onlySuccessfulCandidate],
      FLIGHTS_FLOW_STEPS,
      EMPTY_VOCABULARY
    );

    expect(result?.capture).toBe(onlySuccessfulCandidate);
    expect(result?.endpointPath).toBe("/graphql/page-chrome");
  });
});
