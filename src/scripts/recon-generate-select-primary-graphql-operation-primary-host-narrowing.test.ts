import { describe, expect, it } from "vitest";
import { EMPTY_VOCABULARY } from "@/recon/vocabulary";
import { selectPrimaryGraphQLOperation } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

const PRIMARY_HOST = "catalog.example.com";
const MINORITY_HOST = "cdn.catalog.example.com";
const FALLBACK_DOMAIN = "example.com";

function makeCapture(overrides: Partial<Capture>): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "filter",
    method: "POST",
    url: `https://${PRIMARY_HOST}/graphql`,
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

describe("selectPrimaryGraphQLOperation primaryHost narrowing", () => {
  it("resolves the dominant primary-host operation over a minority undeclared-subdomain operation on the same fallbackDomain", () => {
    const primaryCapture = makeCapture({
      url: `https://${PRIMARY_HOST}/graphql`,
      operationName: "SearchListings",
      query: "query SearchListings($filters: String) { listings(filters: $filters) { id name } }",
      variables: { filters: "category:widgets" },
      responseBody: {
        listings: Array.from({ length: 5 }, (_, i) => ({ id: i, name: `Listing ${i}` })),
      },
    });
    const minorityCapture = makeCapture({
      url: `https://${MINORITY_HOST}/graphql`,
      operationName: "MinorityWidgets",
      query:
        "query MinorityWidgets($filters: String) { minorityWidgets(filters: $filters) { id } }",
      variables: { filters: "category:widgets" },
      responseBody: {
        minorityWidgets: Array.from({ length: 200 }, (_, i) => ({ id: i })),
      },
    });

    const captures = [minorityCapture, primaryCapture];
    const flowSteps = [
      { step: "select 'widgets' from the Category dropdown", payloadField: "category" },
    ];

    const result = selectPrimaryGraphQLOperation(
      captures,
      flowSteps,
      EMPTY_VOCABULARY,
      process.env,
      [PRIMARY_HOST, MINORITY_HOST],
      FALLBACK_DOMAIN,
      null,
      PRIMARY_HOST
    );

    expect(result?.capture).toBe(primaryCapture);
  });

  it("omitting primaryHost preserves existing behavior for current callers", () => {
    const ownBackend = makeCapture({
      url: `https://${PRIMARY_HOST}/graphql`,
      operationName: "SearchListings",
      query: "query SearchListings($filters: String) { listings(filters: $filters) { id name } }",
      variables: { filters: "category:widgets" },
      responseBody: {
        listings: Array.from({ length: 5 }, (_, i) => ({ id: i, name: `Listing ${i}` })),
      },
    });

    const captures = [ownBackend];
    const flowSteps = [
      { step: "select 'widgets' from the Category dropdown", payloadField: "category" },
    ];

    const result = selectPrimaryGraphQLOperation(
      captures,
      flowSteps,
      EMPTY_VOCABULARY,
      process.env,
      [PRIMARY_HOST],
      null
    );

    expect(result?.capture).toBe(ownBackend);
  });
});
