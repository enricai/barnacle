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
} from "@/scripts/recon-generate";
import {
  extractExecuteHttpBodyFromContract,
  stripEmitterTypeAssertions,
} from "@/scripts/recon-generate-execute-http-harness.test-helper";

const BASE = "https://api.example.com";

const CATALOG_QUERY =
  "query catalogSearch { catalogSearch { items { currency taxIncluded sailingId } } }";

/**
 * A GraphQL query-primary flow with TWO items driving their OWN per-item
 * drill-down, each at a distinct endpoint identity (`/details/1`,
 * `/details/2`). Both drills are called with the SAME `currency`/
 * `taxIncluded` request query params (both items share those values), so
 * `detectDrillDownFoldPlan`'s structural heuristic threads `currency` +
 * `taxIncluded` — response-only, coincidentally overlapping fields — as its
 * OWN guessed `joinFields` for EVERY target it resolves. The flow declares
 * `foldReturn.joinFields: ["sailingId"]`, a field that never threads into
 * either drill's request and is resolvable only against each drill's own
 * response.
 *
 * `buildFoldPlanFromSpec`'s freshest-first scan across matching drill
 * endpoints resolves (and `break`s on) only ONE endpoint per call, so an
 * unrestricted spec resolution can only ever override ONE of the two
 * structurally-detected targets — exercised here through
 * `extractGraphQLActionSequence -> compileActionSteps -> resolveFoldPlan ->
 * emitContractTs`'s single-primary `getGql`/`httpClient` fold-merge loop, the
 * sibling of `emitMultiStepExecuteHttp`'s already-fixed per-item loop.
 */
function catalogSearchCapture(): unknown {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: CATALOG_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      catalogSearch: {
        items: [
          { currency: "USD", taxIncluded: true, sailingId: "sail-1" },
          { currency: "USD", taxIncluded: true, sailingId: "sail-2" },
        ],
      },
    },
    operationName: "catalogSearch",
    query: CATALOG_QUERY,
    variables: {},
    decodedParams: null,
  };
}

function drillCapture(sailingId: string, timestamp: string, index: number): unknown {
  return {
    timestamp,
    phase: "browse",
    method: "GET",
    url: `${BASE}/listings/api/v1/details/${index}?currency=USD&taxIncluded=true`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {
      detail: [
        {
          currency: "USD",
          taxIncluded: true,
          sailingId,
          balance: sailingId === "sail-1" ? 100 : 200,
        },
      ],
    },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/listings/api/v1/details/",
  resultsPath: "catalogSearch.items",
  drillResultsPath: "detail",
  joinFields: ["sailingId"],
};

function buildActionSteps(): ReturnType<typeof compileActionSteps> {
  const captures = [
    catalogSearchCapture(),
    drillCapture("sail-1", "2026-01-01T00:00:01Z", 1),
    drillCapture("sail-2", "2026-01-01T00:00:02Z", 2),
  ] as never[];
  const actionCaptures = extractGraphQLActionSequence(captures, null, SPEC);
  const stateIndex = indexStateValues(
    captures,
    new Set(),
    new Set(actionCaptures.map((a) => a.index))
  );
  return compileActionSteps(actionCaptures, stateIndex);
}

function generateContract(siteId: string): string {
  const actionSteps = buildActionSteps();
  const primaryResponseBody = actionSteps[0]!.capture.responseBody;
  return emitContractTs({
    siteId,
    pascal: "FoldreturnResponseOnlySinglePrimaryOverrideTest",
    baseUrl: BASE,
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: primaryResponseBody,
    gql: true,
    gqlQuery: CATALOG_QUERY,
    endpointPath: "/graphql",
    gqlOperationName: "catalogSearch",
    gqlVariables: {},
    auxFiles: [],
    actionSteps,
    foldReturnSpec: SPEC,
  });
}

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

function stubDrillFetch(): void {
  const fn = vi.fn(async (url: string) => {
    if (url.includes("/details/1")) {
      return jsonResponse({
        detail: [{ currency: "USD", taxIncluded: true, sailingId: "sail-1", balance: 100 }],
      });
    }
    return jsonResponse({
      detail: [{ currency: "USD", taxIncluded: true, sailingId: "sail-2", balance: 200 }],
    });
  });
  vi.stubGlobal("fetch", fn);
}

function evalSinglePrimaryExecuteHttp(
  body: string,
  getGql: (
    baseUrl: string
  ) => (
    operationName: string,
    query: string,
    variables: Record<string, unknown>
  ) => Promise<unknown>,
  httpClient: ReturnType<typeof createHttpClient>
): (payload: Record<string, unknown>, context: { baseUrl: string }) => Promise<{ data: unknown }> {
  const stripped = stripEmitterTypeAssertions(body);
  const factory = new Function(
    "getGql",
    "httpClient",
    "z",
    "FOLDRETURNRESPONSEONLYSINGLEPRIMARYOVERRIDETEST_QUERY",
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
  return factory(getGql, httpClient, z, CATALOG_QUERY);
}

describe("recon-generate foldReturn declared joinFields — response-only field on the single-primary getGql/httpClient fold-merge loop", () => {
  it("emits the declared sailingId join key on EVERY per-item drill target, not the currency+taxIncluded structural guess", () => {
    const contract = generateContract(
      `foldreturn-response-only-single-primary-override-${process.pid}`
    );
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    expect(executeHttpBody.match(/m\["sailingId"\]/g)?.length).toBe(2);
    expect(executeHttpBody).not.toContain('m["currency"]');
    expect(executeHttpBody).not.toContain('m["taxIncluded"]');
    expect(executeHttpBody.match(/\/listings\/api\/v1\/details\//g)?.length).toBe(2);
  });

  it("folds each per-item drill's response by the declared sailingId at runtime, never the currency+taxIncluded decoy", async () => {
    const contract = generateContract(
      `foldreturn-response-only-single-primary-override-rt-${process.pid}`
    );
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubDrillFetch();

    const gqlCalls: { operationName: string; query: string; variables: unknown }[] = [];
    const getGql =
      (_baseUrl: string) =>
      async (operationName: string, query: string, variables: Record<string, unknown>) => {
        gqlCalls.push({ operationName, query, variables });
        return {
          catalogSearch: {
            items: [
              { currency: "USD", taxIncluded: true, sailingId: "sail-1" },
              { currency: "USD", taxIncluded: true, sailingId: "sail-2" },
            ],
          },
        };
      };

    const executeHttp = evalSinglePrimaryExecuteHttp(executeHttpBody, getGql, httpClient);
    const result = await executeHttp({}, { baseUrl: BASE });

    expect(gqlCalls).toHaveLength(1);
    expect(result.data).toEqual({
      catalogSearch: {
        items: [
          { currency: "USD", taxIncluded: true, sailingId: "sail-1", balance: 100 },
          { currency: "USD", taxIncluded: true, sailingId: "sail-2", balance: 200 },
        ],
      },
    });
    // Each item re-issues BOTH per-item drill targets (details/1 and
    // details/2) — 2 items * 2 targets = 4 — since the fold loop has no way
    // to know in advance which target's response matches a given item; only
    // the declared sailingId join correctly discards the non-matching
    // target's response for each item. The primary itself goes through the
    // mocked getGql, not fetch.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
  });
});
