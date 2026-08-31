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
 * Locks in the fold-plan/emitted-primary drift guard: when a foldReturn
 * spec's resultsPath only resolves against one GraphQL operation (op B)
 * while a DIFFERENT operation on the same endpoint (op A) is the one whose
 * capture emitContractTs is told is the emitted primary — as happens when
 * op A is captured far more often and wins recurrence-based primary
 * selection upstream — emitContractTs must never emit a fold cast built
 * against op B's shape while `data` at runtime actually holds op A's
 * response.
 */
const FACETS_QUERY = "query catalogFacets { catalogFacets { code label } }";
const SEARCH_QUERY =
  "query catalogSearch($skip: Int) { catalogSearch(skip: $skip) { total items { id title } } }";

function catalogFacetsCapture(index: number): unknown {
  return {
    timestamp: `2024-01-01T00:00:0${index}Z`,
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: FACETS_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      catalogFacets: [
        { code: "n", label: "North" },
        { code: "s", label: "South" },
      ],
    },
    operationName: "catalogFacets",
    query: FACETS_QUERY,
    variables: {},
    decodedParams: null,
  };
}

function catalogSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:09Z",
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: { skip: 0 } }),
    responseHeaders: {},
    responseBody: {
      catalogSearch: {
        total: 2,
        items: [
          { id: "entry-1", title: "Entry One" },
          { id: "entry-2", title: "Entry Two" },
        ],
      },
    },
    operationName: "catalogSearch",
    query: SEARCH_QUERY,
    variables: { skip: 0 },
    decodedParams: null,
  };
}

function restDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:10Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/api/v1/details?id=entry-1`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { detail: [{ id: "entry-1", climate: "temperate" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const SEARCH_ITEMS_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/api/v1/details",
  resultsPath: "catalogSearch.items",
  drillResultsPath: "detail",
  joinFields: ["id"],
};

function buildActionSteps(): ReturnType<typeof compileActionSteps> {
  // Three captures of the facets-shaped op (op A) vs. one of the
  // search-shaped op (op B) so op A — carrying no `catalogSearch.items`
  // array the spec's resultsPath could ever resolve against — is the one
  // recurrence-based primary selection upstream would prefer, while op B
  // is the only capture buildFoldPlanFromSpec can resolve a fold plan
  // against at all.
  const captures = [
    catalogFacetsCapture(1),
    catalogFacetsCapture(2),
    catalogFacetsCapture(3),
    catalogSearchCapture(),
    restDrillDownCapture(),
  ] as never[];
  const actionCaptures = extractGraphQLActionSequence(captures, null, SEARCH_ITEMS_SPEC);
  const stateIndex = indexStateValues(
    captures,
    new Set(),
    new Set(actionCaptures.map((a) => a.index))
  );
  return compileActionSteps(actionCaptures, stateIndex);
}

describe("fold plan primary op diverging from the emitted primary op", () => {
  it("never emits a fold cast against a path absent from the emitted primary's response type", () => {
    const actionSteps = buildActionSteps();
    const emittedPrimaryBody = catalogFacetsCapture(1);
    const emittedPrimaryResponseBody = (
      emittedPrimaryBody as { responseBody: unknown }
    ).responseBody;

    const buildContract = (): string =>
      emitContractTs({
        siteId: "fold-plan-primary-op-mismatch-test",
        pascal: "FoldPlanPrimaryOpMismatchTest",
        baseUrl: BASE,
        baseHeaders: { "Content-Type": "application/json" },
        minTime: 100,
        safeRps: 10,
        // The emitted primary is op A (catalogFacets) — the operation
        // selectPrimaryGraphQLOperation-style recurrence counting would
        // pick, given it appears three times to op B's one.
        responseBody: emittedPrimaryResponseBody,
        gql: true,
        gqlQuery: FACETS_QUERY,
        endpointPath: "/graphql",
        gqlOperationName: "catalogFacets",
        gqlVariables: {},
        auxFiles: [],
        actionSteps,
        foldReturnSpec: SEARCH_ITEMS_SPEC,
      });

    let contract: string | null = null;
    let thrown: unknown = null;
    try {
      contract = buildContract();
    } catch (error) {
      thrown = error;
    }

    if (thrown !== null) {
      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain("catalogFacets");
      expect(message).toContain("catalogSearch");
      return;
    }

    // If emission did not throw, it must not have resolved the fold plan
    // against op B's shape: a cast/merge referencing `catalogSearch` (only
    // present on op B's response, never on the emitted op A response) would
    // be a reference to a path absent from the emitted primary's type.
    expect(contract).not.toBeNull();
    expect(contract).not.toContain("catalogSearch");
  });
});
