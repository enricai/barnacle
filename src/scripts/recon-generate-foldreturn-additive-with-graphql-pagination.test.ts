import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitContractTs,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
  resolveApplicableFoldPlans,
} from "@/scripts/recon-generate";
import { extractExecuteHttpBodyFromContract } from "@/scripts/recon-generate-execute-http-harness.test-helper";

const BASE = "https://api.example.com";

/**
 * Locks in the bugfix-001 fix (recon-generate.ts's `emitContractTs`
 * threading the resolved single-primary fold plan into
 * `buildPaginatedGqlExecuteHttpBody`'s loop) with the same extraction-
 * through-emission chain `recon-generate-graphql-primary-get-drilldown-fold-
 * runtime-e2e.test.ts` exercises for the non-paginated case, but with a
 * primary operation whose `variables`/response also carry a bounded-paging
 * signal (`detectPaginationSignal`/`findPaginationContainer`,
 * recon-generate.ts L5179-5202, L6839-6869). Before the fix,
 * `singlePrimaryFoldPlans` was unconditionally zeroed whenever
 * `paginationSignal` was also detected, so the emitted contract was
 * byte-identical with and without a declared `foldReturn` and the drill-
 * down/merge never made it into the paginated fetch loop.
 */

const SEARCH_QUERY =
  "query catalogSearch($skip: Int, $take: Int) { catalogSearch(skip: $skip, take: $take) { total items { id title } } }";

function catalogSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: { skip: 0, take: 2 } }),
    responseHeaders: {},
    responseBody: {
      catalogSearch: {
        total: 4,
        items: [
          { id: "entry-1", title: "Entry One" },
          { id: "entry-2", title: "Entry Two" },
        ],
      },
    },
    operationName: "catalogSearch",
    query: SEARCH_QUERY,
    variables: { skip: 0, take: 2 },
    decodedParams: null,
  };
}

function restDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/api/v1/details?id=entry-1`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { detail: [{ id: "entry-1", region: "north" }] },
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

function buildActionSteps(): {
  actionSteps: ReturnType<typeof compileActionSteps>;
  primaryResponseBody: unknown;
} {
  const captures = [catalogSearchCapture(), restDrillDownCapture()] as never[];
  const actionCaptures = extractGraphQLActionSequence(captures, null, CATALOG_DETAILS_SPEC);
  const stateIndex = indexStateValues(
    captures,
    new Set(),
    new Set(actionCaptures.map((a) => a.index))
  );
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);
  return { actionSteps, primaryResponseBody: actionSteps[0]?.capture.responseBody };
}

function emitCatalogContract(
  actionSteps: ReturnType<typeof compileActionSteps>,
  primaryResponseBody: unknown,
  foldReturnSpec: FoldReturnSpec | null
): string {
  return emitContractTs({
    siteId: "catalog-pagination-fold-test",
    pascal: "CatalogPaginationFoldTest",
    baseUrl: BASE,
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: primaryResponseBody,
    gql: true,
    gqlQuery: SEARCH_QUERY,
    endpointPath: "/graphql",
    gqlOperationName: "catalogSearch",
    gqlVariables: { skip: 0, take: 2 },
    auxFiles: [],
    actionSteps,
    foldReturnSpec,
  });
}

describe("GraphQL query-primary + pagination signal + foldReturn — extraction through emitContractTs", () => {
  it("resolves a non-empty fold plan for the paginated primary, matching the guard main() consults before warning 'no fold plan resolved'", () => {
    const { actionSteps } = buildActionSteps();

    const foldPlans = resolveApplicableFoldPlans(actionSteps, CATALOG_DETAILS_SPEC, undefined);

    expect(foldPlans.length).toBeGreaterThan(0);
    expect(foldPlans[0]!.targets.length).toBeGreaterThan(0);
  });

  it("threads the resolved fold's drill-down call and merge into the paginated fetch loop, differing byte-for-byte from the same flow with no foldReturn", () => {
    const { actionSteps, primaryResponseBody } = buildActionSteps();
    const withFold = emitCatalogContract(actionSteps, primaryResponseBody, CATALOG_DETAILS_SPEC);
    // Extraction itself needs the declared foldReturn to keep the GET
    // drill-down capture at all (see the sibling runtime-e2e file's own
    // falsifier: with no spec, `extractGraphQLActionSequence` drops both the
    // GraphQL primary and the drill-down) — so `actionSteps: []` here is the
    // faithful "no foldReturn declared" flow, not just a flag flip on the
    // same steps.
    const withoutFold = emitCatalogContract([], primaryResponseBody, null);

    expect(withFold).not.toEqual(withoutFold);

    // The paginated branch fires for both (pagination detection is
    // independent of foldReturn) — pin that first, so a divergence in the
    // assertions below is provably about the fold, not about silently
    // falling back to the non-paginated single-call emission.
    expect(withFold).toContain("const MAX_PAGES = payload.maxPages ?? 50;");
    expect(withoutFold).toContain("const MAX_PAGES = payload.maxPages ?? 50;");

    const withFoldBody = extractExecuteHttpBodyFromContract(withFold);
    const withoutFoldBody = extractExecuteHttpBodyFromContract(withoutFold);

    // Fold merge runs once, after the paging loop, against the final
    // de-duplicated `itemsById` collection — not inside the per-page loop
    // body, and not dropped as a silent no-op the way the pre-fix regression
    // produced (byte-identical output with/without a declared foldReturn).
    expect(withFoldBody).toContain("for (const item of foldItems)");
    expect(withFoldBody).toContain("itemsById.values()");
    expect(withFoldBody.indexOf("for (const item of foldItems)")).toBeLessThan(
      withFoldBody.indexOf("const truncated = itemsById.size < total;")
    );
    expect(withFoldBody).toMatch(/\}\n\s*const truncated = itemsById\.size < total;/);

    expect(withoutFoldBody).not.toContain("for (const item of foldItems)");
  });
});
