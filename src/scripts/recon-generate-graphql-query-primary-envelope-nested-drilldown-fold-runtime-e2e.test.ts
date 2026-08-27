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
 * Extends recon-generate-graphql-primary-get-drilldown-fold-runtime-e2e.test.ts's
 * nested-wildcard case to a data-enveloped, 3+-static-segment resultsPath
 * (`data.op.results.groups.*.items`) — proving the emitted accessor is a
 * generalized `.flatMap` traversal through every literal segment (envelope
 * included), not a fixed-depth or literal-index shortcut, and that the
 * evaluated executeHttp still folds the drill's field onto the correct
 * nested item across multiple outer groups.
 */

const ENVELOPE_SEARCH_QUERY =
  "query opSearch { op { results { groups { id items { id title } } } } }";

function envelopeGraphqlSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: ENVELOPE_SEARCH_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      data: {
        op: {
          results: {
            groups: [
              {
                id: "group-1",
                items: [
                  { id: "item-1", title: "Widget" },
                  { id: "item-2", title: "Gadget" },
                ],
              },
              {
                id: "group-2",
                items: [{ id: "item-3", title: "Gizmo" }],
              },
            ],
          },
        },
      },
    },
    operationName: "opSearch",
    query: ENVELOPE_SEARCH_QUERY,
    variables: {},
    decodedParams: null,
  };
}

function restDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/listings/api/v1/details?id=item-1`,
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

const ENVELOPE_DETAILS_SPEC: FoldReturnSpec = {
  endpointPattern: "/listings/api/v1/details",
  resultsPath: "data.op.results.groups.*.items",
  drillResultsPath: "detail",
  joinFields: ["id"],
};

const DETAIL_REGIONS_BY_ITEM_ID: Record<string, { detail: { id: string; region: string }[] }> = {
  "item-1": { detail: [{ id: "item-1", region: "north" }] },
  "item-2": { detail: [{ id: "item-2", region: "south" }] },
  "item-3": { detail: [{ id: "item-3", region: "east" }] },
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
    const itemId = new URL(url).searchParams.get("id") ?? "";
    const response = DETAIL_REGIONS_BY_ITEM_ID[itemId];
    if (!response) {
      throw new Error(`stubDetailsFetch: no detail fixture for item id "${itemId}"`);
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

describe("GraphQL-primary + data-enveloped nested-wildcard resultsPath drill-down foldReturn — runtime e2e", () => {
  it("resolves a fold plan and folds the drill-down's field onto every outer group of a data-enveloped nested primary via a generalized .flatMap accessor", async () => {
    const captures = [envelopeGraphqlSearchCapture(), restDrillDownCapture()] as never[];

    const actionCaptures = extractGraphQLActionSequence(captures, null, ENVELOPE_DETAILS_SPEC);
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

    const foldPlans = resolveFoldPlan(actionSteps, ENVELOPE_DETAILS_SPEC);
    expect(foldPlans.length).toBeGreaterThan(0);
    expect(foldPlans[0]!.targets.length).toBeGreaterThan(0);

    const primaryResponseBody = actionSteps[0]!.capture.responseBody;

    const contract = emitContractTs({
      siteId: "envelope-nested-fold-test",
      pascal: "EnvelopeNestedFoldTest",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: primaryResponseBody,
      gql: true,
      gqlQuery: ENVELOPE_SEARCH_QUERY,
      endpointPath: "/graphql",
      gqlOperationName: "opSearch",
      gqlVariables: {},
      auxFiles: [],
      actionSteps,
      foldReturnSpec: ENVELOPE_DETAILS_SPEC,
    });

    expect(contract).toContain("getGql(context.baseUrl)(");

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);
    // The envelope's nested wildcard group must generalize across every
    // outer group via .flatMap — a literal index into one group (e.g.
    // `.groups[0].items`) would silently drop every other group's items at
    // runtime.
    expect(executeHttpBody).toContain(".flatMap(");
    expect(executeHttpBody).not.toMatch(/\.groups\[\d+\]/);
    expect(executeHttpBody).toContain("for (const item of foldItems)");

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
      "ENVELOPENESTEDFOLDTEST_QUERY",
      ENVELOPE_SEARCH_QUERY
    );
    const result = await executeHttp({}, { baseUrl: BASE });

    expect(gqlCalls).toHaveLength(1);
    expect(gqlCalls[0]!.operationName).toBe("opSearch");

    expect(result.data).toEqual({
      data: {
        op: {
          results: {
            groups: [
              {
                id: "group-1",
                items: [
                  { id: "item-1", title: "Widget", region: "north" },
                  { id: "item-2", title: "Gadget", region: "south" },
                ],
              },
              {
                id: "group-2",
                items: [{ id: "item-3", title: "Gizmo", region: "east" }],
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
