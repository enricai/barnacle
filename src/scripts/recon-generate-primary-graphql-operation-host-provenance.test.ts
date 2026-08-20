import { describe, expect, it } from "vitest";
import { EMPTY_VOCABULARY } from "@/recon/vocabulary";
import { selectPrimaryGraphQLOperation } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

function makeCapture(overrides: Partial<Capture>): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "browse",
    method: "POST",
    url: "https://api.example.com/graphql",
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

describe("selectPrimaryGraphQLOperation host provenance gate", () => {
  it("never selects a third-party host capture over a smaller, less recurrent own-backend capture", () => {
    const ownBackend = makeCapture({
      url: "https://api.example.com/graphql",
      phase: "filter",
      operationName: "SearchListings",
      query: "query SearchListings($filters: String) { listings(filters: $filters) { id name } }",
      variables: { filters: "category:widgets" },
      responseBody: {
        listings: Array.from({ length: 5 }, (_, i) => ({ id: i, name: `Listing ${i}` })),
      },
    });
    const thirdParty = makeCapture({
      url: "https://sdk.thirdpartyanalytics.com/graphql",
      phase: "filter",
      operationName: "SearchListings",
      query: "query SearchListings($filters: String) { listings(filters: $filters) { id name } }",
      variables: { filters: "category:widgets" },
      responseBody: {
        listings: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `Listing ${i}` })),
      },
    });
    const thirdPartyRepeat = makeCapture({
      url: "https://sdk.thirdpartyanalytics.com/graphql",
      phase: "filter",
      operationName: "SearchListings",
      query: "query SearchListings($filters: String) { listings(filters: $filters) { id name } }",
      variables: { filters: "category:widgets" },
      responseBody: {
        listings: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `Listing ${i}` })),
      },
    });

    const captures = [thirdParty, thirdPartyRepeat, ownBackend];
    const flowSteps = [
      { step: "select 'widgets' from the Category dropdown", payloadField: "category" },
    ];

    const result = selectPrimaryGraphQLOperation(
      captures,
      flowSteps,
      EMPTY_VOCABULARY,
      process.env,
      ["api.example.com"],
      null
    );

    expect(result?.capture).toBe(ownBackend);
  });
});
