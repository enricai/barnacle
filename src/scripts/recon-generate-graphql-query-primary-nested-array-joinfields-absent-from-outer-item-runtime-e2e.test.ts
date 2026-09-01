import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  compileActionSteps,
  emitContractTs,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
  resolveFoldPlan,
} from "@/scripts/recon-generate";
import {
  extractExecuteHttpBodyFromContract,
  stripEmitterTypeAssertions,
} from "@/scripts/recon-generate-execute-http-harness.test-helper";

const BASE = "https://api.example.com";

/**
 * Regression for recon-generate-foldreturn-ignores-declared-joinfields-and-folds-at-wrong-level.md:
 * a declared single `joinFields: ["id"]` where `id` is a plain field on BOTH
 * a nested primary array (`groups[].entries[]`) and the drill array, but
 * absent from the outer primary item (`groups[]`). The outer item instead
 * carries a boolean field (`featured`) whose value is echoed verbatim by the
 * drill response for every entry — the exact shape that previously made the
 * heuristic fabricate a join on that boolean (Bug 1) and merge onto the outer
 * `groups[]` item instead of the declared `resultsPath` array (Bug 2).
 */

const CATALOG_BROWSE_QUERY =
  "query catalogBrowse { catalogBrowse { groups { featured entries { id title } } } }";

function catalogBrowseCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: CATALOG_BROWSE_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      catalogBrowse: {
        groups: [
          {
            featured: true,
            entries: [
              { id: "entry-1", title: "Widget" },
              { id: "entry-2", title: "Gadget" },
            ],
          },
          {
            featured: true,
            entries: [{ id: "entry-3", title: "Gizmo" }],
          },
        ],
      },
    },
    operationName: "catalogBrowse",
    query: CATALOG_BROWSE_QUERY,
    variables: {},
    decodedParams: null,
  };
}

function detailsDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/api/v1/details?id=entry-1`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { detail: [{ id: "entry-1", featured: true, region: "north" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const NESTED_ARRAY_DETAILS_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/api/v1/details",
  resultsPath: "catalogBrowse.groups.*.entries",
  drillResultsPath: "detail",
  joinFields: ["id"],
};

/** `featured: true` is identical on every outer group AND every drill
 * response — a fabricated join on it would let `.find()` match ANY entry
 * (or silently fall back to `foldMatches0[0]`), so only a genuine `id` join
 * can route each drill response to its own entry. */
const DETAILS_BY_ID: Record<
  string,
  { detail: { id: string; featured: boolean; region: string }[] }
> = {
  "entry-1": { detail: [{ id: "entry-1", featured: true, region: "north" }] },
  "entry-2": { detail: [{ id: "entry-2", featured: true, region: "south" }] },
  "entry-3": { detail: [{ id: "entry-3", featured: true, region: "east" }] },
};

function jsonResponse(body: unknown): {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  headers: Headers;
} {
  return {
    status: 200,
    ok: true,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    headers: new Headers(),
  };
}

function stubDetailsFetch(): void {
  const fn = vi.fn(async (url: string) => {
    const id = new URL(url).searchParams.get("id") ?? "";
    const response = DETAILS_BY_ID[id];
    if (!response) {
      throw new Error(`stubDetailsFetch: no detail fixture for id "${id}"`);
    }
    return jsonResponse(response);
  });
  vi.stubGlobal("fetch", fn);
}

/**
 * Evaluates the single-primary hot path's `executeHttp` body — mirrors the
 * established harness in recon-generate-graphql-query-primary-envelope-nested-drilldown-fold-runtime-e2e.test.ts.
 */
function evalSinglePrimaryExecuteHttp(
  body: string,
  getGql: (
    baseUrl: string
  ) => (
    operationName: string,
    query: string,
    variables: Record<string, unknown>
  ) => Promise<unknown>,
  httpClient: ReturnType<typeof createHttpClient>,
  queryConstName: string,
  queryText: string
): (payload: Record<string, unknown>, context: { baseUrl: string }) => Promise<{ data: unknown }> {
  const stripped = stripEmitterTypeAssertions(body);
  const factory = new Function(
    "getGql",
    "httpClient",
    "z",
    queryConstName,
    `return async function executeHttp(payload, context) {\n${stripped}\n};`
  ) as (
    getGqlArg: unknown,
    httpClientArg: unknown,
    zArg: unknown,
    queryArg: string
  ) => (
    payload: Record<string, unknown>,
    context: { baseUrl: string }
  ) => Promise<{ data: unknown }>;
  return factory(getGql, httpClient, z, queryText);
}

describe("GraphQL query-primary + nested-array joinFields absent from the outer primary item — runtime e2e", () => {
  it("honors the declared joinFields verbatim and merges onto the nested resultsPath array, not the outer item", async () => {
    const captures = [catalogBrowseCapture(), detailsDrillDownCapture()] as never[];

    const actionCaptures = extractGraphQLActionSequence(captures, null, NESTED_ARRAY_DETAILS_SPEC);
    expect(actionCaptures.map((a) => (a.capture as { method: string }).method)).toEqual([
      "POST",
      "GET",
    ]);

    const stateIndex = indexStateValues(
      captures,
      new Set(),
      new Set(actionCaptures.map((a) => a.index))
    );
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);
    expect(actionSteps).toHaveLength(2);

    const foldPlans = resolveFoldPlan(actionSteps, NESTED_ARRAY_DETAILS_SPEC);
    expect(foldPlans.length).toBeGreaterThan(0);
    expect(foldPlans[0]!.targets.length).toBeGreaterThan(0);
    expect(foldPlans[0]!.targets[0]!.joinFields).toEqual(["id"]);

    const primaryResponseBody = actionSteps[0]!.capture.responseBody;

    const contract = emitContractTs({
      siteId: "nested-array-joinfields-test",
      pascal: "NestedArrayJoinFieldsTest",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: primaryResponseBody,
      gql: true,
      gqlQuery: CATALOG_BROWSE_QUERY,
      endpointPath: "/graphql",
      gqlOperationName: "catalogBrowse",
      gqlVariables: {},
      auxFiles: [],
      actionSteps,
      foldReturnSpec: NESTED_ARRAY_DETAILS_SPEC,
    });

    expect(contract).toContain("getGql(context.baseUrl)(");

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    // Bug 1: the fold match must key on the declared `id`, never on the
    // decoy boolean that happens to be identical across every group/drill
    // pair.
    expect(executeHttpBody).toMatch(/m(\?\.)?\[["']id["']\]/);
    expect(executeHttpBody).not.toMatch(/foldMatch(es)?\d*\.find\([^)]*featured/);
    expect(executeHttpBody).not.toContain('m["featured"]');

    // Bug 2: the merge must land on the nested `entries[]` array declared by
    // `resultsPath` (`catalogBrowse.groups.*.entries`), not on the outer
    // `groups[]` item — so the loop must traverse into `entries` via a
    // generalized nested loop, never index a single literal group.
    expect(executeHttpBody).toContain("for (const g0 of");
    expect(executeHttpBody).toContain("entries");
    expect(executeHttpBody).not.toMatch(/\.groups\[\d+\]/);
    expect(executeHttpBody).toContain("for (const item of g0.entries)");

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubDetailsFetch();

    const gqlCalls: { operationName: string; query: string; variables: unknown }[] = [];
    const getGql =
      (_baseUrl: string) =>
      async (operationName: string, query: string, variables: Record<string, unknown>) => {
        gqlCalls.push({ operationName, query, variables });
        return primaryResponseBody;
      };

    const executeHttp = evalSinglePrimaryExecuteHttp(
      executeHttpBody,
      getGql,
      httpClient,
      "NESTEDARRAYJOINFIELDSTEST_QUERY",
      CATALOG_BROWSE_QUERY
    );
    const result = await executeHttp({}, { baseUrl: BASE });

    expect(gqlCalls).toHaveLength(1);
    expect(gqlCalls[0]!.operationName).toBe("catalogBrowse");

    // Every nested entry across both outer groups must be enriched with its
    // OWN matching drill region, keyed by `id` — never falling back to
    // `foldMatches[0]` (which would put "north" on every entry).
    expect(result.data).toEqual({
      catalogBrowse: {
        groups: [
          {
            featured: true,
            entries: [
              { id: "entry-1", title: "Widget", featured: true, region: "north" },
              { id: "entry-2", title: "Gadget", featured: true, region: "south" },
            ],
          },
          {
            featured: true,
            entries: [{ id: "entry-3", title: "Gizmo", featured: true, region: "east" }],
          },
        ],
      },
    });
    // One drill-down call per nested entry, flattened across both groups.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });
});
