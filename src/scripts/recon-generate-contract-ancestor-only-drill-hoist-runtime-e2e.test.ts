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
 * Closes the coverage gap left by commit 52a166f (#343): its ancestor-only-
 * params regression only exercised `emitMultiStepExecuteHttp` via the raw-
 * eval harness, never `emitContractTs` — the generated-plugin `contract.ts`
 * path the reported bug's own broken/fixed samples are drawn from. Mirrors
 * `recon-generate-graphql-query-primary-envelope-nested-drilldown-fold-runtime-e2e.test.ts`'s
 * GraphQL-primary harness and
 * `buildMulticallNestedGroupedDrillDownAncestorOnlyParamsActionSteps`'s
 * ancestor-only drill URL shape (keyed only by the group id, never an item
 * field).
 */

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

function stubGroupDetailsFetch(): void {
  const fn = vi.fn(async (url: string) => {
    const groupId = new URL(url).searchParams.get("groupId") ?? "";
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

describe("emitContractTs — all-ancestor-scoped REST drill hoisted above the item loop with a GraphQL primary", () => {
  it("structurally hoists the drill call above the item loop, threads only the ancestor accessor, and dedups the drill fetch", async () => {
    const captures = [groupsGraphqlSearchCapture(), ancestorOnlyDrillCapture()] as never[];

    const actionCaptures = extractGraphQLActionSequence(captures, null, ANCESTOR_ONLY_DETAILS_SPEC);
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

    const foldPlans = resolveFoldPlan(actionSteps, ANCESTOR_ONLY_DETAILS_SPEC);
    expect(foldPlans.length).toBeGreaterThan(0);
    expect(foldPlans[0]!.targets.length).toBeGreaterThan(0);

    const primaryResponseBody = actionSteps[0]!.capture.responseBody;

    const contract = emitContractTs({
      siteId: "ancestor-only-drill-hoist-test",
      pascal: "AncestorOnlyDrillHoistTest",
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

    expect(contract).toContain("getGql(context.baseUrl)(");
    expect((contract.match(/await httpClient\(/g) ?? []).length).toBe(1);

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    // Structural hoist: the drill's `await httpClient(` call site must sit
    // between the ancestor-group loop open and the per-item loop open.
    const groupLoopIndex = executeHttpBody.indexOf("for (const g0 of");
    const drillCallIndex = executeHttpBody.indexOf("await httpClient(");
    const itemLoopIndex = executeHttpBody.indexOf("for (const item of");

    expect(groupLoopIndex).toBeGreaterThanOrEqual(0);
    expect(drillCallIndex).toBeGreaterThanOrEqual(0);
    expect(itemLoopIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillCallIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillCallIndex).toBeLessThan(itemLoopIndex);

    // The drill URL threads only the ancestor accessor — never an item field.
    const drillUrlLineMatch = executeHttpBody
      .slice(drillCallIndex, itemLoopIndex)
      .match(/`[^`]*groupId=\$\{[^}]+\}[^`]*`/);
    expect(drillUrlLineMatch).not.toBeNull();
    const drillUrlTemplate = drillUrlLineMatch![0];
    expect(drillUrlTemplate).toMatch(/\$\{g0\./);
    expect(drillUrlTemplate).not.toContain("${item.");

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubGroupDetailsFetch();

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
      "ANCESTORONLYDRILLHOISTTEST_QUERY",
      GROUPS_QUERY
    );
    const result = await executeHttp({}, { baseUrl: BASE });

    expect(gqlCalls).toHaveLength(1);
    expect(gqlCalls[0]!.operationName).toBe("groupsSearch");

    expect(result.data).toEqual({
      data: {
        search: {
          groups: [
            {
              id: "group-1",
              items: [
                { id: "item-1", title: "Widget", region: "north" },
                { id: "item-2", title: "Gadget", region: "south" },
                { id: "item-3", title: "Doohickey", region: "east" },
              ],
            },
            {
              id: "group-2",
              items: [{ id: "item-4", title: "Gizmo", region: "west" }],
            },
          ],
        },
      },
    });

    // Exactly one drill fetch per group — not per item — even though
    // group-1 holds three items.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(fetch).mock.calls;
    expect(String(calls[0]![0])).toContain("groupId=group-1");
    expect(String(calls[1]![0])).toContain("groupId=group-2");
  });
});
