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
 * Regression e2e for bugfix-002 (recon-generate.ts's `resolveApplicableFoldPlans`
 * freshest-wins collapse, see `recon-generate-fold-plan.test.ts`'s
 * "resolveApplicableFoldPlans — collapsing pagination/re-filter variant plans"
 * describe block) exercised through the actual emission boundary: a declared
 * `foldReturn` whose primary GraphQL operation is captured multiple times
 * with differing variables (the query/pagination/facet-variant shape the
 * report describes) followed each time by its own matching drill-down must
 * still produce exactly one drill+fold block in the emitted contract.ts, not
 * one per captured variant.
 */

const SEARCH_QUERY =
  "query catalogSearch($filter: String) { catalogSearch(filter: $filter) { items { id title } } }";

function catalogSearchCapture(filter: string, itemId: string, timestamp: string): unknown {
  return {
    timestamp,
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: { filter } }),
    responseHeaders: {},
    responseBody: { catalogSearch: { items: [{ id: itemId, title: `Item ${itemId}` }] } },
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

describe("GraphQL query-primary foldReturn — single emission across repeated query/pagination-variant captures", () => {
  it("emits exactly one drill+fold block for a primary op captured under 5 differing-variables variants (r1-r5), each followed by its own drill-down", () => {
    // Five re-filter/re-page occurrences of the SAME primary operation, each
    // with different variables and each independently drilling a DIFFERENT
    // item -- exactly the shape that made detectDrillDownFoldPlan return one
    // structural plan per occurrence before the freshest-wins collapse.
    const variants = ["north-metro", "south-metro", "east-metro", "west-metro", "central-metro"];
    const captures: unknown[] = [];
    variants.forEach((filter, i) => {
      const itemId = `item-${i}`;
      captures.push(
        catalogSearchCapture(filter, itemId, `2024-01-01T00:00:${String(i * 2).padStart(2, "0")}Z`)
      );
      captures.push(
        detailCapture(
          itemId,
          `region-${i}`,
          `2024-01-01T00:00:${String(i * 2 + 1).padStart(2, "0")}Z`
        )
      );
    });

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

    // The freshest occurrence's primary response is what the single-primary
    // hot path's inferred shape and executeHttp body are built from.
    const freshestPrimaryStep = [...actionSteps]
      .reverse()
      .find((step) => (step.capture as { method: string }).method === "POST");
    expect(freshestPrimaryStep).toBeDefined();

    const contract = emitContractTs({
      siteId: "multi-variant-fold-test",
      pascal: "MultiVariantFoldTest",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: freshestPrimaryStep!.capture.responseBody,
      gql: true,
      gqlQuery: SEARCH_QUERY,
      endpointPath: "/graphql",
      gqlOperationName: "catalogSearch",
      gqlVariables: { filter: variants[variants.length - 1] },
      auxFiles: [],
      actionSteps,
      foldReturnSpec: CATALOG_DETAILS_SPEC,
    });

    // Exactly one fold-match declaration pair -- no second numbered plan's
    // `foldMatches1`/`foldMatch1` from a duplicate, un-collapsed occurrence.
    const foldMatchesDeclarations = contract.match(/const foldMatches\d*\s*=/g) ?? [];
    const foldMatchDeclarations = contract.match(/const foldMatch\d*\s*=/g) ?? [];
    expect(foldMatchesDeclarations.length).toBe(1);
    expect(foldMatchDeclarations.length).toBe(1);
    expect(contract).not.toMatch(/foldMatches1/);
    expect(contract).not.toMatch(/foldMatch1\b/);

    // Exactly one drill-down call site against the declared foldReturn's
    // endpoint, not one per captured variant.
    const drillEndpointOccurrences = contract.match(/\/catalog\/api\/v1\/details/g) ?? [];
    expect(drillEndpointOccurrences.length).toBe(1);

    // The single-primary hot path emits exactly one GraphQL query call site
    // (the freshest variant) -- the duplication the report describes spans
    // both the drill+fold block and the primary httpClient query blocks, so
    // this also proves the emission wasn't inflated to one query block per
    // captured variant.
    const gqlCallSites = contract.match(/getGql\(context\.baseUrl\)\(/g) ?? [];
    expect(gqlCallSites.length).toBe(1);
  });
});
