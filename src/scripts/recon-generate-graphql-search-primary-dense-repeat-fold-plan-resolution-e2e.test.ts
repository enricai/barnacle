import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitContractTs,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
  resolveFoldPlan,
} from "@/scripts/recon-generate";

const BASE = "https://api.example.com";

/**
 * Regression e2e for
 * docs/recon-generate-real-graphql-primary-excluded-from-fold-candidate-pool.md,
 * exercised through the exact pipeline the report traced —
 * `extractGraphQLActionSequence` -> `compileActionSteps` ->
 * `resolveApplicableFoldPlans` — unlike the sibling
 * recon-generate-graphql-query-primary-redundant-same-operation-search-captures-runtime-e2e.test.ts,
 * which only repeats its primary 3x with `responseHeaders: {}` — below
 * `MIN_DENSE_REPEAT_FOR_RESPONSE_VARIANCE_SIGNAL` and missing the explicit
 * content-type header, both of which sidestep the buggy branch in
 * `isZeroVarianceRepeatCapture`'s query-less varying-body path (see
 * src/recon/capture-filters.ts L1006-L1023) entirely. This test repeats the
 * primary >=10 times with an explicit `application/json` content-type on
 * every occurrence, landing squarely on the previously-broken branch.
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
    responseHeaders: { "content-type": "application/json" },
    responseBody: {
      catalogSearch: {
        items: [
          { id: `item-${filter}-1`, title: "Item 1" },
          { id: `item-${filter}-2`, title: "Item 2" },
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

describe("GraphQL search primary densely re-issued with a freely-varying JSON response — fold plan resolution", () => {
  it("keeps a search primary captured >=10x with distinct variables in extractGraphQLActionSequence's output, and resolves a fold plan referencing the drill-down", () => {
    const REPEAT_COUNT = 12;
    const searchCaptures = Array.from({ length: REPEAT_COUNT }, (_, i) =>
      catalogSearchCapture(
        `category:outdoor|page:${i}`,
        `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`
      )
    );
    const captures: unknown[] = [
      ...searchCaptures,
      detailCapture(
        `item-category:outdoor|page:${REPEAT_COUNT - 1}-1`,
        "region-A",
        `2024-01-01T00:00:${String(REPEAT_COUNT).padStart(2, "0")}Z`
      ),
    ];

    const actionCaptures = extractGraphQLActionSequence(
      captures as never[],
      null,
      CATALOG_DETAILS_SPEC
    );

    // The dense-repeat search primary must survive extraction — not be
    // silently dropped as a false-positive "noise widget" — plus its
    // trailing drill-down.
    const primaryOccurrences = actionCaptures.filter(
      (a) => (a.capture as { method: string }).method === "POST"
    );
    expect(primaryOccurrences.length).toBe(REPEAT_COUNT);
    const drillOccurrences = actionCaptures.filter(
      (a) => (a.capture as { method: string }).method === "GET"
    );
    expect(drillOccurrences.length).toBe(1);

    const stateIndex = indexStateValues(
      captures as never[],
      new Set(),
      new Set(actionCaptures.map((a) => a.index))
    );
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);

    const foldPlans = resolveFoldPlan(actionSteps, CATALOG_DETAILS_SPEC);
    expect(foldPlans.length).toBeGreaterThan(0);
    expect(foldPlans[0]!.targets.length).toBeGreaterThan(0);

    const freshestPrimaryStep = [...actionSteps]
      .reverse()
      .find((step) => (step.capture as { method: string }).method === "POST");
    expect(freshestPrimaryStep).toBeDefined();

    let warned = false;
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      if (args.some((a) => typeof a === "string" && a.includes("no fold plan resolved"))) {
        warned = true;
      }
      originalWarn(...args);
    };
    try {
      const contract = emitContractTs({
        siteId: "search-primary-dense-repeat-fold-test",
        pascal: "SearchPrimaryDenseRepeatFoldTest",
        baseUrl: BASE,
        baseHeaders: { "Content-Type": "application/json" },
        minTime: 100,
        safeRps: 10,
        responseBody: freshestPrimaryStep!.capture.responseBody,
        gql: true,
        gqlQuery: SEARCH_QUERY,
        endpointPath: "/graphql",
        gqlOperationName: "catalogSearch",
        gqlVariables: { filter: `category:outdoor|page:${REPEAT_COUNT - 1}` },
        auxFiles: [],
        actionSteps,
        foldReturnSpec: CATALOG_DETAILS_SPEC,
      });

      expect(warned).toBe(false);
      expect(contract).not.toContain("no fold plan resolved");
      expect(contract).toContain("getGql(context.baseUrl)(");
      expect(contract).toContain("foldItems");
    } finally {
      console.warn = originalWarn;
    }
  });
});
