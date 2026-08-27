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
 * The one uncovered shape flagged by
 * docs/recon-generate-foldreturn-silently-ignored-for-graphql-query-primary-flows.md's
 * suggested-fix language about threading multiple per-item fields into the
 * drill call: a GraphQL query-primary flow whose declared `foldReturn.joinFields`
 * names MORE THAN ONE field, exercised through the same
 * extractGraphQLActionSequence -> compileActionSteps -> resolveFoldPlan ->
 * emitContractTs -> evaluated executeHttp chain as the existing
 * single-field-join e2e tests. Every other `*-fold-runtime-e2e` file covering
 * composite joinFields (e.g. recon-generate-drilldown-fold-composite-join-runtime-e2e.test.ts)
 * exercises the multi-step (non-GraphQL, non-single-primary) emitter instead.
 */

const CATALOG_SEARCH_QUERY = "query catalogSearch { catalogSearch { items { id region title } } }";

function catalogSearchCapture(): unknown {
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
      catalogSearch: {
        items: [
          { id: "item-1", region: "us", title: "Widget" },
          { id: "item-2", region: "eu", title: "Gadget" },
        ],
      },
    },
    operationName: "catalogSearch",
    query: CATALOG_SEARCH_QUERY,
    variables: {},
    decodedParams: null,
  };
}

/** Request is threaded on `id` alone; the drill response additionally echoes
 * `region`, so a merge that keys on only the FIRST declared joinFields entry
 * (`id`) would accept a decoy sharing the same `id` but a different `region`. */
function detailsDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/listings/api/v1/details?id=item-1`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { detail: [{ id: "item-1", region: "us", balance: 100 }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const COMPOSITE_JOIN_DETAILS_SPEC: FoldReturnSpec = {
  endpointPattern: "/listings/api/v1/details",
  resultsPath: "catalogSearch.items",
  drillResultsPath: "detail",
  joinFields: ["id", "region"],
};

/** Every drill response returns a decoy sharing the requested `id` but the
 * OTHER item's `region`, ahead of the real match — so a fold that only
 * re-keyed on the first joinFields entry (`id`) would silently accept the
 * decoy for at least one item. */
const DETAILS_BY_ID: Record<string, { detail: { id: string; region: string; balance: number }[] }> =
  {
    "item-1": {
      detail: [
        { id: "item-1", region: "eu", balance: -1 },
        { id: "item-1", region: "us", balance: 100 },
      ],
    },
    "item-2": {
      detail: [
        { id: "item-2", region: "us", balance: -1 },
        { id: "item-2", region: "eu", balance: 250 },
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

describe("GraphQL query-primary + composite (multi-field) joinFields drill-down foldReturn — runtime e2e", () => {
  it("resolves a fold plan whose target.joinFields has length > 1 for a composite-keyed drill", () => {
    const captures = [catalogSearchCapture(), detailsDrillDownCapture()] as never[];

    const actionCaptures = extractGraphQLActionSequence(
      captures,
      null,
      COMPOSITE_JOIN_DETAILS_SPEC
    );
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

    const foldPlans = resolveFoldPlan(actionSteps, COMPOSITE_JOIN_DETAILS_SPEC);
    expect(foldPlans.length).toBeGreaterThan(0);
    expect(foldPlans[0]!.targets.length).toBeGreaterThan(0);
    expect(foldPlans[0]!.targets[0]!.joinFields.length).toBeGreaterThan(1);
    expect(foldPlans[0]!.targets[0]!.joinFields).toEqual(["id", "region"]);
  });

  it("folds the correct drill item onto each primary item, matching on ALL composite joinFields, and rejects a decoy matching only the first field", async () => {
    const captures = [catalogSearchCapture(), detailsDrillDownCapture()] as never[];

    const actionCaptures = extractGraphQLActionSequence(
      captures,
      null,
      COMPOSITE_JOIN_DETAILS_SPEC
    );
    const stateIndex = indexStateValues(
      captures,
      new Set(),
      new Set(actionCaptures.map((a) => a.index))
    );
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);
    const primaryResponseBody = actionSteps[0]!.capture.responseBody;

    const contract = emitContractTs({
      siteId: "composite-join-fold-test",
      pascal: "CompositeJoinFoldTest",
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
      actionSteps,
      foldReturnSpec: COMPOSITE_JOIN_DETAILS_SPEC,
    });

    expect(contract).toContain("getGql(context.baseUrl)(");
    expect(contract).toContain("/listings/api/v1/details");
    // Both declared joinFields must appear in the match line — a merge that
    // only re-keyed on the first entry (`id`) would never reference `region`
    // in the generated match predicate at all.
    expect(contract).toContain('m["id"]');
    expect(contract).toContain('m["region"]');

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);
    expect(executeHttpBody).toContain("for (const item of foldItems)");
    expect(executeHttpBody).toContain("item.id");

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
      "COMPOSITEJOINFOLDTEST_QUERY",
      CATALOG_SEARCH_QUERY
    );
    const result = await executeHttp({}, { baseUrl: BASE });

    expect(gqlCalls).toHaveLength(1);
    expect(gqlCalls[0]!.operationName).toBe("catalogSearch");

    // Each item's decoy shares its `id` but carries the OTHER item's
    // `region` — a merge keyed on only the first joinFields entry would
    // fold the decoy's balance (-1) onto every item instead of the real
    // match.
    expect(result.data).toEqual({
      catalogSearch: {
        items: [
          { id: "item-1", region: "us", title: "Widget", balance: 100 },
          { id: "item-2", region: "eu", title: "Gadget", balance: 250 },
        ],
      },
    });
    // One drill-down call per primary item — the primary GraphQL call itself
    // goes through the mocked `getGql`, not `fetch`.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
