import { describe, expect, it } from "vitest";
import { EMPTY_VOCABULARY } from "@/recon/vocabulary";
import {
  compileActionSteps,
  dedupRedundantSameOperationCaptures,
  emitContractTs,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
  selectPrimaryGraphQLOperation,
} from "@/scripts/recon-generate";

const BASE = "https://api.example.com";

/**
 * Regression e2e for
 * docs/recon-generate-dedup-keys-on-operationname-so-an-endpoint-queried-under-an-alias-survives.md,
 * exercised across the FULL extraction-through-emission chain (unlike
 * recon-generate-graphql-query-primary-redundant-same-operation-capture-dedup-unit.test.ts,
 * which pins `dedupRedundantSameOperationCaptures` in isolation on
 * hand-built `ActionCapture[]`). The primary read here is re-issued a
 * second time under a DIFFERENT parsed `operationName` at the SAME
 * endpoint, with a `responseBody` whose top-level object-array field
 * resolves to the same shape as the primary's -- an aliased re-issue of
 * the same logical read, not a genuinely distinct operation. Before the
 * fix, only an exact `operationGroupKey` match (endpoint + operation name)
 * was deduped, so the alias survived and was emitted as its own redundant
 * `httpClient` call alongside the primary's `getGql` call and the
 * genuinely distinct `foldReturn` drill.
 */

const PRIMARY_QUERY = "query catalogSearch { catalogSearch { items { id title } } }";
const ALIAS_QUERY = "query catalogSearchResults { catalogSearch { items { id title } } }";

function catalogSearchCapture(timestamp: string): unknown {
  return {
    timestamp,
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: PRIMARY_QUERY, variables: {} }),
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
    query: PRIMARY_QUERY,
    variables: {},
    decodedParams: null,
  };
}

/**
 * Same endpoint, a DIFFERENT parsed operationName, and a response whose
 * top-level object-array field ("catalogSearch.items") resolves to the
 * same shape as the primary's own response -- the aliased re-issue the
 * broadened dedup key is meant to catch.
 */
function aliasedCatalogSearchCapture(timestamp: string): unknown {
  return {
    timestamp,
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: ALIAS_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      catalogSearch: {
        items: [
          { id: "item-1", title: "Item 1" },
          { id: "item-2", title: "Item 2" },
        ],
      },
    },
    operationName: "catalogSearchResults",
    query: ALIAS_QUERY,
    variables: {},
    decodedParams: null,
  };
}

function catalogDetailsCapture(itemId: string, timestamp: string): unknown {
  return {
    timestamp,
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/api/v1/details?id=${itemId}`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { detail: [{ id: itemId, region: "region-A" }] },
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

describe("GraphQL alias-endpoint redundant read dedup — extraction through emission e2e", () => {
  it("collapses an aliased re-issue of the primary read (same endpoint, different operationName, same response shape) to a single getGql call plus the genuinely distinct drill", () => {
    const captures = [
      catalogSearchCapture("2024-01-01T00:00:00Z"),
      aliasedCatalogSearchCapture("2024-01-01T00:00:01Z"),
      catalogDetailsCapture("item-1", "2024-01-01T00:00:02Z"),
    ] as never[];

    const actionCaptures = extractGraphQLActionSequence(captures, null, CATALOG_DETAILS_SPEC);
    expect(actionCaptures).toHaveLength(3);

    const primary = selectPrimaryGraphQLOperation(captures, [], EMPTY_VOCABULARY);
    expect(primary?.capture.operationName).toBe("catalogSearch");

    const deduped = dedupRedundantSameOperationCaptures(actionCaptures, primary);

    // The alias is dropped; the primary and the genuinely distinct drill
    // both survive, unaffected by the broadened dedup key.
    expect(
      deduped.map((a) => (a.capture as { operationName: string | null }).operationName)
    ).toEqual(["catalogSearch", null]);

    const stateIndex = indexStateValues(captures, new Set(), new Set(deduped.map((a) => a.index)));
    const actionSteps = compileActionSteps(deduped, stateIndex);
    expect(actionSteps).toHaveLength(2);

    const primaryResponseBody = actionSteps[0]!.capture.responseBody;

    const contract = emitContractTs({
      siteId: "alias-endpoint-dedup-test",
      pascal: "AliasEndpointDedupTest",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: primaryResponseBody,
      gql: true,
      gqlQuery: PRIMARY_QUERY,
      endpointPath: "/graphql",
      gqlOperationName: "catalogSearch",
      gqlVariables: {},
      auxFiles: [],
      actionSteps,
      foldReturnSpec: CATALOG_DETAILS_SPEC,
    });

    // Exactly one paged primary read via getGql -- no redundant httpClient
    // POST against the alias's own occurrence of the same /graphql endpoint.
    const gqlCallSites = contract.match(/getGql\(context\.baseUrl\)\(/g) ?? [];
    expect(gqlCallSites).toHaveLength(1);
    expect(contract).toContain("getGql(context.baseUrl)(");

    // Exactly one httpClient call: the genuinely distinct drill against the
    // details endpoint. Zero httpClient calls against the primary's own
    // endpoint pathname (/graphql) -- the alias never became its own call.
    const httpClientCalls = contract.match(/await httpClient\(/g) ?? [];
    expect(httpClientCalls).toHaveLength(1);
    expect(contract).not.toMatch(/await httpClient\(`\$\{context\.baseUrl\}\/graphql/);

    // The drill's foldReturn/join machinery is unaffected by the dedup fix.
    expect(contract).toContain("/catalog/api/v1/details");
    expect(contract).toContain('m["id"]');

    const executeHttpBody = contract;
    expect(executeHttpBody).toContain("for (const item of foldItems)");
  });
});
