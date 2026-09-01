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
 * The exact shape
 * docs/recon-generate-foldreturn-ignores-declared-joinfields-and-folds-at-wrong-level.md's
 * "suggested fix" names: an explicit single `joinFields: ["id"]` where `id`
 * is a plain field on both a NESTED primary array (never on the outer
 * primary item) and the drill array. The outer item only carries a boolean
 * that's ALSO echoed verbatim by the drill response — plausible bait for a
 * structural false-positive join on a boolean instead of the declared `id`
 * (Bug 1) — and the resultsPath names the nested array, not the outer item,
 * so a merge that lands on the outer item instead of the nested array
 * element (Bug 2) is caught too. Two captures of the primary query (a
 * re-filter) also exercise bugfix-002's single-emission collapse (Bug 3).
 */

const GROUP_SEARCH_QUERY =
  "query groupSearch { groupSearch { groups { groupId promoActive sailings { id region } } } }";

function groupSearchCapture(groupId: string, sailingId: string, page: number): unknown {
  return {
    timestamp: `2024-01-01T00:00:0${page}Z`,
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      query: GROUP_SEARCH_QUERY,
      variables: { page },
    }),
    responseHeaders: {},
    responseBody: {
      groupSearch: {
        groups: [
          {
            groupId,
            promoActive: true,
            sailings: [{ id: sailingId, region: "north" }],
          },
        ],
      },
    },
    operationName: "groupSearch",
    query: GROUP_SEARCH_QUERY,
    variables: { page },
    decodedParams: null,
  };
}

/** Parameterized on the outer item's own field (`groupId`), never on the
 * declared joinFields (`id`) — mirrors the report's
 * `groupId=${item.id}` drill threading. Every drill response ALSO echoes
 * `promoActive: true` on every sailing (matching the primary's own
 * `promoActive`), so a merge that fabricated a join on that boolean instead
 * of honoring the declared `id` would match every sailing indiscriminately
 * and could silently fold the wrong one. */
function sailingsDrillDownCapture(
  groupId: string,
  sailingId: string,
  secondsPastMinute: number
): unknown {
  return {
    timestamp: `2024-01-01T00:00:${String(secondsPastMinute).padStart(2, "0")}Z`,
    phase: "browse",
    method: "GET",
    url: `${BASE}/itinerary/api/v1/sailings?groupId=${groupId}`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {
      sailings: [
        { id: "decoy-sailing", region: "WRONG", promoActive: true },
        { id: sailingId, region: "south", promoActive: true },
      ],
    },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const GROUP_SAILINGS_SPEC: FoldReturnSpec = {
  endpointPattern: "/itinerary/api/v1/sailings",
  resultsPath: "groupSearch.groups.*.sailings",
  drillResultsPath: "sailings",
  joinFields: ["id"],
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

const SAILINGS_BY_GROUP_ID: Record<
  string,
  { sailings: { id: string; region: string; promoActive: boolean }[] }
> = {
  "group-2": {
    sailings: [
      { id: "decoy-sailing", region: "WRONG", promoActive: true },
      { id: "sail-2a", region: "south", promoActive: true },
    ],
  },
};

function stubSailingsFetch(): void {
  const fn = vi.fn(async (url: string) => {
    const groupId = new URL(url).searchParams.get("groupId") ?? "";
    const response = SAILINGS_BY_GROUP_ID[groupId];
    if (!response) {
      throw new Error(`stubSailingsFetch: no sailings fixture for groupId "${groupId}"`);
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

describe("GraphQL query-primary + plain joinFields on a nested primary array + drill array foldReturn — runtime e2e", () => {
  it("resolves target.joinFields to exactly the declared field, not a structurally-guessed one", () => {
    const captures = [
      // Two captures of the same query (a page-1/re-filter pair) — only
      // the LATER one's own item field ("group-2") appears in the drill's
      // URL, so this also pins that a stale, non-freshest primary
      // occurrence never contributes a competing candidate of its own.
      groupSearchCapture("group-1", "sail-1a", 1),
      groupSearchCapture("group-2", "sail-2a", 2),
      sailingsDrillDownCapture("group-2", "sail-2a", 2),
    ] as never[];

    const actionCaptures = extractGraphQLActionSequence(captures, null, GROUP_SAILINGS_SPEC);
    const stateIndex = indexStateValues(
      captures,
      new Set(),
      new Set(actionCaptures.map((a) => a.index))
    );
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);
    expect(actionSteps).toHaveLength(3);

    const foldPlans = resolveFoldPlan(actionSteps, GROUP_SAILINGS_SPEC);
    expect(foldPlans.length).toBeGreaterThan(0);
    expect(foldPlans[0]!.targets.length).toBeGreaterThan(0);
    // The join must be resolved to exactly the declared field — never the
    // decoy boolean (`promoActive`) both sides also happen to share.
    expect(foldPlans[0]!.targets[0]!.joinFields).toEqual(["id"]);
  });

  it("emits a fold match on the declared id verbatim, merges at the nested sailings array level, and emits exactly one drill+fold block despite two primary captures", async () => {
    const captures = [
      // Two captures of the same query (a page-1/re-filter pair) — only
      // the LATER one's own item field ("group-2") appears in the drill's
      // URL, so this also pins that a stale, non-freshest primary
      // occurrence never contributes a competing candidate of its own.
      groupSearchCapture("group-1", "sail-1a", 1),
      groupSearchCapture("group-2", "sail-2a", 2),
      sailingsDrillDownCapture("group-2", "sail-2a", 2),
    ] as never[];

    const actionCaptures = extractGraphQLActionSequence(captures, null, GROUP_SAILINGS_SPEC);
    const stateIndex = indexStateValues(
      captures,
      new Set(),
      new Set(actionCaptures.map((a) => a.index))
    );
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);
    // The freshest (latest) primary occurrence — the collapse this test
    // pins should anchor emission on this one, mirroring the report's
    // pagination/re-filter symptom.
    const primaryResponseBody = actionSteps[1]!.capture.responseBody;

    const contract = emitContractTs({
      siteId: "nested-plain-joinfield-fold-test",
      pascal: "NestedPlainJoinfieldFoldTest",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: primaryResponseBody,
      gql: true,
      gqlQuery: GROUP_SEARCH_QUERY,
      endpointPath: "/graphql",
      gqlOperationName: "groupSearch",
      gqlVariables: {},
      auxFiles: [],
      actionSteps,
      foldReturnSpec: GROUP_SAILINGS_SPEC,
    });

    expect(contract).toContain("getGql(context.baseUrl)(");
    expect(contract).toContain("/itinerary/api/v1/sailings");

    // Bug 1: the emitted fold match must reference the declared `id`
    // verbatim, never the decoy boolean both sides happen to share.
    expect(contract).toContain('m["id"]');
    expect(contract).not.toContain('m["promoActive"]');
    expect(contract).not.toContain('m?.["promoActive"]');

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);
    // Bug 2: the fold loop must walk the declared nested sailings array
    // (resultsPath's own level), never the outer groups array — a merge
    // that lands one level too shallow would iterate `groups`, not
    // `sailings`, and `item.id` would be undefined for every outer item.
    // resultsPath crosses the outer "groups" array, so the fold-merge loop
    // is a nested `for` (not a flattened `foldItems`) — see
    // pathToFoldLoopLines's docstring.
    expect(executeHttpBody).toContain("for (const item of g0.sailings)");
    expect(executeHttpBody).toContain("item.id");
    expect(executeHttpBody).not.toContain("item.groupId ===");

    // Bug 3: exactly one drill+fold loop block, even with two primary
    // query captures (a re-filter) in the source recording.
    const drillFoldLoopOccurrences =
      executeHttpBody.match(/for \(const item of g0\.sailings\)/g) ?? [];
    expect(drillFoldLoopOccurrences).toHaveLength(1);
    const sailingsEndpointOccurrences =
      executeHttpBody.match(/\/itinerary\/api\/v1\/sailings/g) ?? [];
    expect(sailingsEndpointOccurrences).toHaveLength(1);

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubSailingsFetch();

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
      "NESTEDPLAINJOINFIELDFOLDTEST_QUERY",
      GROUP_SEARCH_QUERY
    );
    const result = await executeHttp({}, { baseUrl: BASE });

    expect(gqlCalls).toHaveLength(1);
    expect(gqlCalls[0]!.operationName).toBe("groupSearch");

    // Runtime proof of Bug 1 + Bug 2: the outer `group-2` item is untouched
    // except for its nested `sailings` array's matching element (`id:
    // "sail-2a"`) gaining the drilled `region` — never the decoy sharing
    // `promoActive`, and never `Object.assign`ed onto the outer group.
    expect(result.data).toEqual({
      groupSearch: {
        groups: [
          {
            groupId: "group-2",
            promoActive: true,
            sailings: [{ id: "sail-2a", region: "south", promoActive: true }],
          },
        ],
      },
    });
    // One drill-down call for the single folded sailing.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});
