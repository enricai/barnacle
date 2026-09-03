import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitContractTs,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
} from "@/scripts/recon-generate";

const BASE = "https://api.example.com";

/**
 * Regression e2e for
 * docs/recon-generate-read-flow-chains-redundant-same-operation-search-captures.md
 * exercised through the actual emission boundary, following the same
 * extractGraphQLActionSequence -> compileActionSteps -> emitContractTs
 * pattern as
 * recon-generate-graphql-query-primary-foldreturn-single-emission-across-query-variants-runtime-e2e.test.ts.
 * That sibling test covers a primary re-issued with ITS OWN drill each time
 * (one foldReturn per variant). This test covers the report's own shape: the
 * SAME primary read operation captured 3x with different variables/phases
 * (a multi-phase re-issue, e.g. pagination/re-filter/an SPA re-firing it
 * during a funnel walk) followed by exactly ONE foldReturn drill shared by
 * all of them -- the shape that chained every redundant capture into the
 * fold emission as its own httpClient call before the fix.
 */

const SEARCH_QUERY =
  "query catalogSearch($filter: String) { catalogSearch(filter: $filter) { items { id title } } }";

function catalogSearchCapture(filter: string, timestamp: string): unknown {
  return {
    timestamp,
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: { filter } }),
    responseHeaders: {},
    responseBody: {
      catalogSearch: {
        items: [
          { id: "item-1", title: "Item 1" },
          { id: "item-2", title: "Item 2" },
        ],
      },
    },
    operationName: "catalogSearch",
    query: SEARCH_QUERY,
    variables: { filter },
    decodedParams: null,
  };
}

function detailCapture(itemId: string, region: string, timestamp: string): unknown {
  return {
    timestamp,
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/api/v1/details?id=${itemId}`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { detail: [{ id: itemId, region }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const CATALOG_DETAILS_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/api/v1/details",
  resultsPath: "catalogSearch.items",
  drillResultsPath: "detail",
  joinFields: ["id"],
};

describe("GraphQL query-primary redundant same-operation search captures — single fold emission across multi-phase re-issues", () => {
  it("emits exactly two kinds of executeHttp call for a primary op captured 3x (different variables/phases) plus one shared foldReturn drill", () => {
    // Three re-filter/re-phase occurrences of the SAME primary operation --
    // mirroring the report's multi-phase re-issue shape (pagination,
    // re-filtering across phases, an SPA re-firing it during a funnel walk)
    // -- followed by exactly ONE drill-down shared by all of them, not one
    // drill per occurrence.
    const captures: unknown[] = [
      catalogSearchCapture("category:outdoor", "2024-01-01T00:00:00Z"),
      catalogSearchCapture("category:outdoor|price:50~100", "2024-01-01T00:00:01Z"),
      catalogSearchCapture("category:outdoor|price:50~100|brand:acme", "2024-01-01T00:00:02Z"),
      detailCapture("item-1", "region-A", "2024-01-01T00:00:03Z"),
    ];

    const actionCaptures = extractGraphQLActionSequence(
      captures as never[],
      null,
      CATALOG_DETAILS_SPEC
    );
    const stateIndex = indexStateValues(
      captures as never[],
      new Set(),
      new Set(actionCaptures.map((a) => a.index))
    );
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);

    const freshestPrimaryStep = [...actionSteps]
      .reverse()
      .find((step) => (step.capture as { method: string }).method === "POST");
    expect(freshestPrimaryStep).toBeDefined();

    const contract = emitContractTs({
      siteId: "redundant-search-capture-test",
      pascal: "RedundantSearchCaptureTest",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: freshestPrimaryStep!.capture.responseBody,
      gql: true,
      gqlQuery: SEARCH_QUERY,
      endpointPath: "/graphql",
      gqlOperationName: "catalogSearch",
      gqlVariables: { filter: "category:outdoor|price:50~100|brand:acme" },
      auxFiles: [],
      actionSteps,
      foldReturnSpec: CATALOG_DETAILS_SPEC,
    });

    // Exactly one drill/fold call site against the declared foldReturn's
    // endpoint -- not one per redundant same-operation search capture.
    const httpClientCalls = contract.match(/await httpClient\(/g) ?? [];
    expect(httpClientCalls.length).toBe(1);

    // Exactly one primary GraphQL query call site -- the redundant search
    // re-issues never become additional fetch steps in the emitted body.
    const gqlCallSites = contract.match(/getGql\(context\.baseUrl\)\(/g) ?? [];
    expect(gqlCallSites.length).toBe(1);

    // Two distinct call KINDS total (the primary and the drill), not one
    // httpClient call per redundant capture (would be 4: 1 primary + 3
    // redundant) and not 5 (primary + 3 redundant + drill).
    expect(httpClientCalls.length + gqlCallSites.length).toBe(2);
  });
});
