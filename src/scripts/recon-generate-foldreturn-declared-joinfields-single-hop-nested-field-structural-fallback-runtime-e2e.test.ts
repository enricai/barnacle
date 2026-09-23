import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  compileActionSteps,
  emitContractTs,
  type FoldReturnSpec,
  indexStateValues,
} from "@/scripts/recon-generate";
import {
  extractExecuteHttpBodyFromContract,
  stripEmitterTypeAssertions,
} from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * A single-hop search -> [token hop] -> drill-down chain, resolved through
 * `emitContractTs`'s single-primary `httpClient` fold-merge loop (the
 * default hot path taken when no `multiStepBody` is supplied) rather than
 * `emitMultiStepExecuteHttp`'s per-item loop. The primary item's own nested
 * `priceSummary.currency` value threads directly into the drill-down's own
 * query string, so `detectDrillDownFoldPlan`'s structural heuristic resolves
 * ITS target's `drillStepIndex` at the drill call itself, with
 * `priceSummary.currency` as its inferred join field. The declared
 * `foldReturn.joinFields` (`orderId`) never threads into any request — it's
 * only resolvable via an upstream header-token hop (`rtoken`, whose request
 * header carries `orderId`) that `resolveSpecMatchedPrimaryItemIndexAlongChain`
 * walks back to — so `buildFoldPlanFromSpec` resolves its own target's
 * `drillStepIndex` (== `entryIndex`) at `rtoken`, a DIFFERENT raw index than
 * the structural target's, even though both targets' chains terminate at the
 * exact same drill call and array. `mergeSpecPlanOntoSamePrimary` must still
 * replace the structural target's inferred `priceSummary.currency` join key
 * with the declared `orderId`, not treat the two as independent drill-downs.
 */
const BASE_URL = "https://api.example.com";
const SEARCH_URL = `${BASE_URL}/orders/search/`;
const TOKEN_URL = `${BASE_URL}/orders/token/`;
const LOOKUP_URL = `${BASE_URL}/orders/lookup/?currency=USD`;

function fixtureCaptures(): Capture[] {
  const search = buildCapture({
    url: SEARCH_URL,
    method: "GET",
    requestPostData: null,
    responseBody: {
      orders: [{ orderId: "ORD1", priceSummary: { currency: "USD", taxIncluded: true } }],
    },
    timestamp: "2026-01-01T00:00:00Z",
  });
  const token = buildCapture({
    url: TOKEN_URL,
    method: "GET",
    requestPostData: null,
    requestHeaders: { "Content-Type": "application/json", "X-Order-Id": "ORD1" },
    responseBody: { token: "tok-1" },
    timestamp: "2026-01-01T00:00:01Z",
  });
  const lookup = buildCapture({
    url: LOOKUP_URL,
    method: "GET",
    requestPostData: null,
    requestHeaders: { "Content-Type": "application/json", "X-Token": "tok-1" },
    responseBody: {
      order: [{ orderId: "ORD1", currency: "USD", total: 42 }],
    },
    timestamp: "2026-01-01T00:00:02Z",
  });
  return [search, token, lookup];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/orders/lookup/",
  resultsPath: "orders",
  drillResultsPath: "order",
  joinFields: ["orderId"],
};

function generateContract(siteId: string): string {
  const captures = fixtureCaptures();
  const actionCaptures = captures.map((capture, index) => ({ capture, index }));
  const stateIndex = indexStateValues(captures);
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);

  return emitContractTs({
    siteId,
    pascal: "FoldreturnJoinfieldsSingleHopNestedFieldTest",
    baseUrl: BASE_URL,
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: captures[0]!.responseBody,
    gql: false,
    gqlQuery: null,
    endpointPath: "/orders/search/",
    gqlOperationName: null,
    gqlVariables: null,
    auxFiles: [],
    actionSteps,
    foldReturnSpec: SPEC,
    isSubmissionFlow: false,
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

function stubSingleHopFetch(): void {
  const fn = vi.fn(async (url: string) => {
    if (url.includes("/orders/lookup/")) {
      return jsonResponse({ order: [{ orderId: "ORD1", currency: "USD", total: 42 }] });
    }
    if (url.includes("/orders/token/")) {
      return jsonResponse({ token: "tok-1" });
    }
    return jsonResponse({
      orders: [{ orderId: "ORD1", priceSummary: { currency: "USD", taxIncluded: true } }],
    });
  });
  vi.stubGlobal("fetch", fn);
}

/**
 * Evaluates the single-primary hot path's `executeHttp` body — it references
 * `context.baseUrl` (not just `payload`), so both bindings are required.
 */
function evalRestSinglePrimaryExecuteHttp(
  body: string,
  httpClient: ReturnType<typeof createHttpClient>
): (payload: Record<string, unknown>, context: { baseUrl: string }) => Promise<{ data: unknown }> {
  const stripped = stripEmitterTypeAssertions(body);
  const factory = new Function(
    "httpClient",
    "z",
    `return async function executeHttp(payload, context) {\n${stripped}\n};`
  ) as (
    httpClientArg: unknown,
    zArg: unknown
  ) => (
    payload: Record<string, unknown>,
    context: { baseUrl: string }
  ) => Promise<{ data: unknown }>;
  return factory(httpClient, z);
}

describe("recon-generate foldReturn declared joinFields — single-hop nested-field structural fallback (single-primary emitContractTs path)", () => {
  it("emits the declared orderId join key on the structural target instead of the nested priceSummary.currency guess", () => {
    const contract = generateContract(`foldreturn-single-hop-nested-decoy-${process.pid}`);
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    expect(executeHttpBody).toContain('m["orderId"]');
    expect(executeHttpBody).not.toContain('m["priceSummary"]');
    expect(executeHttpBody).not.toContain('m["currency"]');
    // Exactly one fold target/drill call for this primary — the declared
    // spec resolution must replace the structural guess in place, not
    // append a second, redundant fold target for the same endpoint.
    expect(executeHttpBody.match(/const foldMatches/g)?.length).toBe(1);
    expect(executeHttpBody.match(/\/orders\/lookup\//g)?.length).toBe(1);
  });

  it("folds the declared orderId join at runtime, never matching by the nested priceSummary.currency decoy", async () => {
    const contract = generateContract(`foldreturn-single-hop-nested-decoy-rt-${process.pid}`);
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubSingleHopFetch();

    const executeHttp = evalRestSinglePrimaryExecuteHttp(executeHttpBody, httpClient);
    const result = await executeHttp({ query: "orders" }, { baseUrl: BASE_URL });

    expect(result.data).toEqual({
      orders: [
        {
          orderId: "ORD1",
          priceSummary: { currency: "USD", taxIncluded: true },
          currency: "USD",
          total: 42,
        },
      ],
    });
    // One primary call plus one drill-down call — the declared orderId
    // target replaces the structural target's own (token-hop-free) chain in
    // place, so the upstream token hop is never re-fetched; a spurious
    // second target for the same endpoint would add both a token call and a
    // second lookup call.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
