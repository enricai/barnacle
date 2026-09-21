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
 * Regression e2e exercised through the exact pipeline
 * docs/recon-generate-real-graphql-primary-excluded-from-fold-candidate-pool.md
 * traced — `extractGraphQLActionSequence` -> `compileActionSteps` ->
 * `resolveFoldPlan` -> `emitContractTs` — for the specific occurrence shape
 * bugfix-001 targets: a search primary densely re-issued against a single
 * GraphQL endpoint where, partway through, the client switches to Automatic
 * Persisted Queries. Those later occurrences carry neither `operationName`
 * nor `query` text — only a persisted-query hash — and can only be
 * recognized as re-issues of the same operation by matching same-endpoint
 * response shape (see `hasStableOperationIdentity` in
 * src/recon/capture-filters.ts). Before that fix, a query-less occurrence had
 * no self-declared identity to group by, fell through to the raw
 * freely-varying-response noise check alongside unrelated one-off operations
 * sharing the endpoint, and was silently dropped — unlike
 * recon-generate-graphql-search-primary-dense-repeat-fold-plan-resolution-e2e.test.ts,
 * whose every occurrence self-declares `operationName`/`query` and so never
 * lands on the query-less branch this test targets.
 */

const SEARCH_QUERY =
  "query catalogSearch($filter: String) { catalogSearch(filter: $filter) { items { id title } } }";
const REPEAT_COUNT = 19;
// Occurrences from this index onward are Automatic-Persisted-Query
// re-issues: the client has already had the document cached by the server
// and sends only the persisted-query hash, so operationName and query are
// both absent. Kept below REPEAT_COUNT / 2 so the earlier, self-identified
// occurrences alone would never establish a plurality without these too.
const APQ_REISSUE_START_INDEX = 10;

function catalogSearchCapture(index: number, timestamp: string): unknown {
  const isApqReissue = index >= APQ_REISSUE_START_INDEX;
  return {
    timestamp,
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      operationName: isApqReissue ? null : "catalogSearch",
      query: isApqReissue ? "" : SEARCH_QUERY,
      variables: { filter: `category:outdoor|page:${index}` },
    }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: {
      catalogSearch: {
        items: [
          { id: `item-${index}-a`, title: `Item ${index} A` },
          { id: `item-${index}-b`, title: `Item ${index} B` },
        ],
      },
    },
    operationName: isApqReissue ? null : "catalogSearch",
    query: isApqReissue ? "" : SEARCH_QUERY,
    variables: { filter: `category:outdoor|page:${index}` },
    decodedParams: null,
  };
}

/** A single/double-occurrence one-off operation sharing the same GraphQL endpoint as the primary. */
function otherOperationCapture(
  operationName: string,
  occurrence: number,
  timestamp: string
): unknown {
  const query = `query ${operationName} { ${operationName} { id } }`;
  return {
    timestamp,
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query, variables: { occurrence } }),
    responseHeaders: {},
    responseBody: { [operationName]: { id: `${operationName}-${occurrence}` } },
    operationName,
    query,
    variables: { occurrence },
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

const OTHER_OPERATION_NAMES = [
  "getNavCategories",
  "getPromoBanner",
  "getUserPrefs",
  "getStoreLocator",
  "getShippingEstimate",
  "getLoyaltyStatus",
  "getRecentlyViewed",
  "getWishlist",
];

const CATALOG_DETAILS_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/api/v1/details",
  resultsPath: "catalogSearch.items",
  drillResultsPath: "detail",
  joinFields: ["id"],
};

describe("GraphQL search primary that switches to Automatic Persisted Queries mid-flow — fold plan resolution", () => {
  it("keeps every occurrence, including the query-less APQ re-issues, in extractGraphQLActionSequence's output and resolves a fold plan referencing the drill-down", () => {
    const searchCaptures = Array.from({ length: REPEAT_COUNT }, (_, i) =>
      catalogSearchCapture(i, `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`)
    );
    const otherCaptures = OTHER_OPERATION_NAMES.flatMap((name, opIndex) =>
      Array.from({ length: (opIndex % 2) + 1 }, (_, occurrence) =>
        otherOperationCapture(
          name,
          occurrence,
          `2024-01-01T00:01:${String(opIndex * 2 + occurrence).padStart(2, "0")}Z`
        )
      )
    );
    // Joins onto the freshest self-identified (named, non-APQ) occurrence's
    // item — the same identity `emitContractTs`'s single-primary hot path
    // anchors its emitted call to (`computeEmittedPrimaryAnchor`) — so the
    // fold plan the CLI actually applies to the emitted contract, and the
    // fold plan `resolveFoldPlan` resolves structurally, agree on the same
    // primary occurrence regardless of whether the APQ re-issues survive.
    const namedTailIndex = APQ_REISSUE_START_INDEX - 1;
    const captures: unknown[] = [
      ...searchCaptures,
      ...otherCaptures,
      detailCapture(`item-${namedTailIndex}-a`, "region-A", "2024-01-01T00:02:00Z"),
    ];

    const actionCaptures = extractGraphQLActionSequence(
      captures as never[],
      null,
      CATALOG_DETAILS_SPEC
    );

    // Every search-primary occurrence must survive extraction — including
    // the query-less APQ re-issues — not be silently dropped as a
    // false-positive "noise widget."
    const primaryOccurrences = actionCaptures.filter(
      (a) =>
        (a.capture as { method: string; url: string }).method === "POST" &&
        (a.capture as { url: string }).url === `${BASE}/graphql` &&
        JSON.stringify((a.capture as { responseBody: unknown }).responseBody).includes(
          "catalogSearch"
        )
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

    const namedPrimaryStep = actionSteps.find(
      (step) =>
        (step.capture as { operationName: string | null }).operationName === "catalogSearch" &&
        JSON.stringify((step.capture as { variables: unknown }).variables).includes(
          `page:${namedTailIndex}`
        )
    );
    expect(namedPrimaryStep).toBeDefined();

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
        siteId: "search-primary-apq-fold-test",
        pascal: "SearchPrimaryApqFoldTest",
        baseUrl: BASE,
        baseHeaders: { "Content-Type": "application/json" },
        minTime: 100,
        safeRps: 10,
        responseBody: namedPrimaryStep!.capture.responseBody,
        gql: true,
        gqlQuery: SEARCH_QUERY,
        endpointPath: "/graphql",
        gqlOperationName: "catalogSearch",
        gqlVariables: { filter: `category:outdoor|page:${namedTailIndex}` },
        auxFiles: [],
        actionSteps,
        foldReturnSpec: CATALOG_DETAILS_SPEC,
      });

      expect(warned).toBe(false);
      expect(contract).not.toContain("no fold plan resolved");
      expect(contract).toContain("getGql(context.baseUrl)(");
      expect(contract).toContain("foldItems");
      expect(contract).toContain("region");
    } finally {
      console.warn = originalWarn;
    }
  });
});
