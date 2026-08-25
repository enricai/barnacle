import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_URL = "https://api.example.com/catalog/search/";
const PRICING_URL = "https://api.example.com/catalog/pricing/";
const PRICE_HISTORY_URL = "https://api.example.com/catalog/price-history";

// Each primary result carries its join key under a NESTED `identifiers`
// object rather than a top-level field, matching
// buildMulticallSingleShotSearchDrillDownNestedJoinFieldChainedDependentActionSteps.
const SEARCH_BODY = {
  results: [{ identifiers: { sku: "sku-a" } }, { identifiers: { sku: "sku-b" } }],
};
// >= 8 chars: `indexStateValues`' MIN_STATE_VALUE_LENGTH floor requires this
// length for the recon-capture value to register as a threaded state value
// at all — a shorter token never gets indexed, so the downstream request
// would silently fall back to an unrelated payload accessor instead of
// threading r1's actual produced value.
const priceTokenFor = (sku: string): string => `price-token-${sku}`;
// r1's own response is a BARE array of a single opaque token — not an
// object-array or flat-object candidate at all (selectDisambiguatedCandidate
// finds nothing to fold there) — while r2 threads that token and holds the
// real per-item data, so the chain must extend PAST an opaque intermediate
// hop with no candidate of its own rather than bailing at r1.
const PRICING_RESPONSE_FOR = (sku: string): string[] => [priceTokenFor(sku)];
const HISTORY_BODY_FOR = (sku: string): { history: { sku: string; asOf: string }[] } => ({
  history: [{ sku, asOf: "2024-11-01" }],
});

/**
 * Builds a nested-join-key primary search + 2-hop chained-drill-down capture
 * shape: `results[]` carries its join key under `identifiers.sku` (as in
 * `buildMulticallSingleShotSearchDrillDownNestedJoinFieldMultiItemActionSteps`),
 * and the drill step (`r1`, pricing) is foldable on its own terms but is also
 * depended on by a further chained step (`r2`, price-history) that threads
 * `r1`'s `priceToken` — combining the nested-join-key and chained-dependent
 * conditions in one runtime pass.
 */
function buildRecordedDependentNestedJoinChainCaptures(): ReturnType<typeof buildCapture>[] {
  return [
    buildCapture({
      url: SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: SEARCH_BODY,
      timestamp: "2024-11-15T00:00:00Z",
    }),
    buildCapture({
      url: PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: PRICING_RESPONSE_FOR("sku-a"),
      timestamp: "2024-11-15T00:00:01Z",
    }),
    buildCapture({
      url: PRICE_HISTORY_URL,
      requestPostData: `{"priceToken":"${priceTokenFor("sku-a")}"}`,
      responseBody: HISTORY_BODY_FOR("sku-a"),
      timestamp: "2024-11-15T00:00:02Z",
    }),
  ];
}

/**
 * Stubs `fetch` to answer the primary search call once, then each chain
 * step's call once per primary item, matched by request body content rather
 * than call order — proving the fold loop re-issues a distinct,
 * correctly-parameterized call per item whose join key was resolved out of a
 * NESTED field, then threads that item's own chain state through to the
 * chain's terminal hop.
 */
function stubDependentNestedJoinChainFetch(): void {
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const responseBody = (() => {
      if (requestBody === null || typeof requestBody.page === "number") return SEARCH_BODY;
      if (typeof requestBody.sku === "string") return PRICING_RESPONSE_FOR(requestBody.sku);
      if (typeof requestBody.priceToken === "string") {
        const sku = requestBody.priceToken.replace("price-token-", "");
        return HISTORY_BODY_FOR(sku);
      }
      throw new Error(
        `stubDependentNestedJoinChainFetch: unrecognized request body ${JSON.stringify(requestBody)}`
      );
    })();
    return Promise.resolve({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify(responseBody)),
      headers: new Headers(),
    });
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate dependent nested-join-key chained drill-down fold executeHttp — generated-and-run integration guard", () => {
  it("folds the chain's terminal fields onto EVERY primary item whose nested join key was resolved and re-threaded through the dependent hop, at runtime", async () => {
    const captures = buildRecordedDependentNestedJoinChainCaptures();
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;

    // Mirrors the real pipeline (recon-generate.ts's orchestrator, not a raw
    // fixture step list): `compileActionSteps` is what actually populates
    // each step's `produces[]` — including r1's `priceToken`, threaded from
    // its own response into r2's request.
    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures);
    const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);

    const body = emitMultiStepExecuteHttp(
      actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      inputBody,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map()
    );

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubDependentNestedJoinChainFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toEqual([
      { identifiers: { sku: "sku-a" }, sku: "sku-a", asOf: "2024-11-01" },
      { identifiers: { sku: "sku-b" }, sku: "sku-b", asOf: "2024-11-01" },
    ]);
    // The intermediate drill step's own fields never land on the folded
    // item — only the chain's TERMINAL step's fields do.
    expect(data.results?.[0]).not.toHaveProperty("priceToken");
    expect(data.results?.[0]).not.toHaveProperty("prices");

    // One primary call, plus one call per chain step (2) per primary item (2).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2 * 2);
  });
});
