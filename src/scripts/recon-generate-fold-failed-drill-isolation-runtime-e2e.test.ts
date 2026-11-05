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

const GROUPS_QUERY = "query groupsSearch { search { groups { id items { id title } } } }";

function groupsGraphqlSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: GROUPS_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      data: {
        search: {
          groups: [
            {
              id: "group-1",
              items: [
                { id: "item-1", title: "Widget" },
                { id: "item-2", title: "Gadget" },
                { id: "item-3", title: "Doohickey" },
              ],
            },
            {
              id: "group-2",
              items: [{ id: "item-4", title: "Gizmo" }],
            },
          ],
        },
      },
    },
    operationName: "groupsSearch",
    query: GROUPS_QUERY,
    variables: {},
    decodedParams: null,
  };
}

function ancestorOnlyDrillCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/listings/api/v1/details?groupId=group-1`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {
      detail: [
        { id: "item-1", region: "north" },
        { id: "item-2", region: "south" },
        { id: "item-3", region: "east" },
      ],
    },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const ANCESTOR_ONLY_DETAILS_SPEC: FoldReturnSpec = {
  endpointPattern: "/listings/api/v1/details",
  resultsPath: "data.search.groups.*.items",
  drillResultsPath: "detail",
  joinFields: ["id"],
};

const DETAIL_REGIONS_BY_GROUP_ID: Record<string, { detail: { id: string; region: string }[] }> = {
  "group-1": {
    detail: [
      { id: "item-1", region: "north" },
      { id: "item-2", region: "south" },
      { id: "item-3", region: "east" },
    ],
  },
  "group-2": { detail: [{ id: "item-4", region: "west" }] },
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

function stubGroupDetailsFetchFailingGroup2(): void {
  const fn = vi.fn(async (url: string) => {
    const groupId = new URL(url).searchParams.get("groupId") ?? "";
    if (groupId === "group-2") return jsonResponse({ detail: [] });
    const response = DETAIL_REGIONS_BY_GROUP_ID[groupId];
    if (!response) {
      throw new Error(`stubGroupDetailsFetch: no detail fixture for group id "${groupId}"`);
    }
    return jsonResponse(response);
  });
  vi.stubGlobal("fetch", fn);
}

/**
 * Evaluates the single-primary hot path's `executeHttp` body — mirrors the
 * established harness in
 * recon-generate-graphql-query-primary-envelope-nested-drilldown-fold-runtime-e2e.test.ts.
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

describe("unproductive drill at runtime drops only its own key", () => {
  it("an empty drill result for one group leaves that group's items un-enriched and the other group's enrichment intact", async () => {
    const captures = [groupsGraphqlSearchCapture(), ancestorOnlyDrillCapture()] as never[];
    const actionCaptures = extractGraphQLActionSequence(captures, null, ANCESTOR_ONLY_DETAILS_SPEC);
    const stateIndex = indexStateValues(
      captures,
      new Set(),
      new Set(actionCaptures.map((a) => a.index))
    );
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);
    expect(resolveFoldPlan(actionSteps, ANCESTOR_ONLY_DETAILS_SPEC).length).toBeGreaterThan(0);
    const primaryResponseBody = actionSteps[0]!.capture.responseBody;
    const contract = emitContractTs({
      siteId: "failed-drill-test",
      pascal: "FailedDrillTest",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: primaryResponseBody,
      gql: true,
      gqlQuery: GROUPS_QUERY,
      endpointPath: "/graphql",
      gqlOperationName: "groupsSearch",
      gqlVariables: {},
      auxFiles: [],
      actionSteps,
      foldReturnSpec: ANCESTOR_ONLY_DETAILS_SPEC,
    });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: new Bottleneck({ maxConcurrent: 1, minTime: 0 }),
      baseHeaders: { "Content-Type": "application/json" },
    });
    stubGroupDetailsFetchFailingGroup2();
    const executeHttp = evalSinglePrimaryExecuteHttp(
      extractExecuteHttpBodyFromContract(contract),
      () => async () => primaryResponseBody,
      httpClient,
      "FAILEDDRILLTEST_QUERY",
      GROUPS_QUERY
    );
    const result = await executeHttp({}, { baseUrl: BASE });
    const groups = (result.data as { data: { search: { groups: { items: Record<string, unknown>[] }[] } } })
      .data.search.groups;
    expect(groups[0]!.items.map((i) => i.region)).toEqual(["north", "south", "east"]);
    expect(groups[1]!.items).toEqual([{ id: "item-4", title: "Gizmo" }]);
  });
});
