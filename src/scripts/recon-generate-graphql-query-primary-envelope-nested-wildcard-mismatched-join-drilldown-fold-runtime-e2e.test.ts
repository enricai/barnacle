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
 * Combines two distinguishing features that no existing `*-fold-runtime-e2e`
 * file exercises together: the data-enveloped 2-level nested wildcard
 * resultsPath from
 * recon-generate-graphql-query-primary-envelope-nested-drilldown-fold-runtime-e2e.test.ts
 * (`data.op.results.groups.*.items`) and the mismatched-join-field drill
 * request from
 * recon-generate-graphql-primary-get-drilldown-fold-runtime-e2e.test.ts's
 * `nonJoinRequestGraphqlSearchCapture`/`nonJoinRequestDrillDownCapture` pair
 * (the drill request is parameterized on a field, `sku`, that differs from
 * the declared `joinFields` `["id"]`; only the drill response echoes `id`).
 * This is the exact shape
 * docs/recon-generate-foldreturn-silently-ignored-for-graphql-query-primary-flows.md
 * reports as unproven by any single existing test.
 */

const CATALOG_SEARCH_QUERY =
  "query catalogSearch { catalogSearch { data { op { results { groups { id items { id sku title } } } } } } }";

function envelopeNestedMismatchGraphqlSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: CATALOG_SEARCH_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      data: {
        op: {
          results: {
            groups: [
              {
                id: "group-1",
                items: [
                  { id: "item-1", sku: "SKU-1", title: "Widget" },
                  { id: "item-2", sku: "SKU-2", title: "Gadget" },
                ],
              },
              {
                id: "group-2",
                items: [{ id: "item-3", sku: "SKU-3", title: "Gizmo" }],
              },
            ],
          },
        },
      },
    },
    operationName: "catalogSearch",
    query: CATALOG_SEARCH_QUERY,
    variables: {},
    decodedParams: null,
  };
}

/**
 * Unlike a plain single-field drill capture, this request is keyed by `sku`
 * (`?sku=SKU-1`) — the declared join field (`id`) never appears in the
 * request at all, only in the response, and on the SAME per-item field name
 * the primary uses.
 */
function mismatchedJoinDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/listings/api/v1/details?sku=SKU-1`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { detail: [{ id: "item-1", region: "north" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const ENVELOPE_NESTED_MISMATCH_SPEC: FoldReturnSpec = {
  endpointPattern: "/listings/api/v1/details",
  resultsPath: "data.op.results.groups.*.items",
  drillResultsPath: "detail",
  joinFields: ["id"],
};

/** Every drill response returns TWO items — the real match plus a decoy
 * sharing the requested `sku` — so a merge that fell back to "first item in
 * the response" instead of actually matching on `id` would silently fold
 * the wrong (decoy) item onto every primary item past the first. */
const DETAIL_REGIONS_BY_SKU: Record<string, { detail: { id: string; region: string }[] }> = {
  "SKU-1": {
    detail: [
      { id: "item-1", region: "north" },
      { id: "decoy-1", region: "WRONG" },
    ],
  },
  "SKU-2": {
    detail: [
      { id: "decoy-2", region: "WRONG" },
      { id: "item-2", region: "south" },
    ],
  },
  "SKU-3": {
    detail: [
      { id: "decoy-3", region: "WRONG" },
      { id: "item-3", region: "east" },
    ],
  },
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
    const sku = new URL(url).searchParams.get("sku") ?? "";
    const response = DETAIL_REGIONS_BY_SKU[sku];
    if (!response) {
      throw new Error(`stubDetailsFetch: no detail fixture for sku "${sku}"`);
    }
    return jsonResponse(response);
  });
  vi.stubGlobal("fetch", fn);
}

/**
 * Evaluates the single-primary hot path's `executeHttp` body — mirrors the
 * established harness in recon-generate-graphql-primary-get-drilldown-fold-runtime-e2e.test.ts.
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

describe("GraphQL query-primary + data-enveloped nested-wildcard resultsPath + mismatched-join-field drill-down foldReturn — runtime e2e", () => {
  it("resolves a fold plan and folds the mismatched-join-field drill-down onto every outer group of a data-enveloped nested primary, matching only on the declared joinFields", async () => {
    const withCaptures = [
      envelopeNestedMismatchGraphqlSearchCapture(),
      mismatchedJoinDrillDownCapture(),
    ] as never[];

    const withActionCaptures = extractGraphQLActionSequence(
      withCaptures,
      null,
      ENVELOPE_NESTED_MISMATCH_SPEC
    );
    expect(withActionCaptures.map((a) => (a.capture as { method: string }).method)).toEqual([
      "POST",
      "GET",
    ]);

    const withStateIndex = indexStateValues(
      withCaptures,
      new Set(),
      new Set(withActionCaptures.map((a) => a.index))
    );
    const withActionSteps = compileActionSteps(withActionCaptures, withStateIndex);
    expect(withActionSteps).toHaveLength(2);

    const foldPlans = resolveFoldPlan(withActionSteps, ENVELOPE_NESTED_MISMATCH_SPEC);
    expect(foldPlans.length).toBeGreaterThan(0);
    expect(foldPlans[0]!.targets.length).toBeGreaterThan(0);

    const primaryResponseBody = withActionSteps[0]!.capture.responseBody;

    const contractWith = emitContractTs({
      siteId: "envelope-nested-mismatch-fold-test",
      pascal: "EnvelopeNestedMismatchFoldTest",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: primaryResponseBody,
      gql: true,
      gqlQuery: CATALOG_SEARCH_QUERY,
      endpointPath: "/graphql",
      gqlOperationName: "catalogSearch",
      gqlVariables: {},
      auxFiles: [],
      actionSteps: withActionSteps,
      foldReturnSpec: ENVELOPE_NESTED_MISMATCH_SPEC,
    });

    // Without a declared foldReturn, extractGraphQLActionSequence drops
    // BOTH the query-primary (a non-mutation capture) and the GET
    // drill-down (matches neither matchesFoldReturn nor
    // matchesFoldReturnResults with a null spec) before the fold pipeline
    // ever sees them — mirroring the falsifier in
    // recon-generate-graphql-primary-get-drilldown-fold-runtime-e2e.test.ts.
    const withoutActionCaptures = extractGraphQLActionSequence(withCaptures, null, null);
    expect(withoutActionCaptures).toHaveLength(0);

    const withoutStateIndex = indexStateValues(withCaptures, new Set(), new Set());
    const withoutActionSteps = compileActionSteps(withoutActionCaptures, withoutStateIndex);
    expect(withoutActionSteps).toHaveLength(0);

    const contractWithout = emitContractTs({
      siteId: "envelope-nested-mismatch-fold-test",
      pascal: "EnvelopeNestedMismatchFoldTest",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: {},
      gql: true,
      gqlQuery: CATALOG_SEARCH_QUERY,
      endpointPath: "/graphql",
      gqlOperationName: "catalogSearch",
      gqlVariables: {},
      auxFiles: [],
      actionSteps: withoutActionSteps,
      foldReturnSpec: null,
    });

    // Withholding the declared foldReturn removes the drill-down from
    // extraction entirely, so the WITHOUT contract has nothing to fold and
    // must not reference the drill endpoint at all.
    expect(contractWith).not.toEqual(contractWithout);
    expect(contractWith).toContain("getGql(context.baseUrl)(");
    expect(contractWith).toContain("/listings/api/v1/details");
    expect(contractWithout).not.toContain("/listings/api/v1/details");
    expect(contractWith).toContain('m["id"]');
    expect(contractWithout).not.toContain('m["id"]');
    expect(contractWithout).not.toContain("foldItems");

    const executeHttpBodyWith = extractExecuteHttpBodyFromContract(contractWith);
    // The envelope's nested wildcard group must generalize across every
    // outer group via a nested loop — a literal index into one group (e.g.
    // `.groups[0].items`) would silently drop every other group's items at
    // runtime.
    expect(executeHttpBodyWith).toContain("for (const g0 of");
    expect(executeHttpBodyWith).not.toMatch(/\.groups\[\d+\]/);
    expect(executeHttpBodyWith).toContain("for (const item of g0.items)");
    // The URL must be parameterized off `sku` — the field the captured
    // request actually varies on — even though the declared joinFields
    // name `id`, a field the request never carries.
    expect(executeHttpBodyWith).toContain("item.sku");
    expect(executeHttpBodyWith).toContain('m["id"]');

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
      executeHttpBodyWith,
      getGql,
      httpClient,
      "ENVELOPENESTEDMISMATCHFOLDTEST_QUERY",
      CATALOG_SEARCH_QUERY
    );
    const result = await executeHttp({}, { baseUrl: BASE });

    expect(gqlCalls).toHaveLength(1);
    expect(gqlCalls[0]!.operationName).toBe("catalogSearch");

    // The merge must pick the response item whose `id` actually matches the
    // primary item's own `id`, not just the first response item (which is a
    // decoy sharing the same `sku`) — this pins the declared joinFields as
    // the match key even though the request itself threads `sku`.
    expect(result.data).toEqual({
      data: {
        op: {
          results: {
            groups: [
              {
                id: "group-1",
                items: [
                  { id: "item-1", sku: "SKU-1", title: "Widget", region: "north" },
                  { id: "item-2", sku: "SKU-2", title: "Gadget", region: "south" },
                ],
              },
              {
                id: "group-2",
                items: [{ id: "item-3", sku: "SKU-3", title: "Gizmo", region: "east" }],
              },
            ],
          },
        },
      },
    });
    // One drill-down call per item, flattened across both outer groups.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });
});
