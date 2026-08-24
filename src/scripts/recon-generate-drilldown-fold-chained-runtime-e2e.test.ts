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

const SEARCH_BODY = { results: [{ sku: "sku-a" }, { sku: "sku-b" }] };
const PRICING_BODY_FOR = (sku: string): { priceToken: string; prices: unknown[] } => ({
  // >= 8 chars: `indexStateValues`' MIN_STATE_VALUE_LENGTH floor requires
  // this length for the recon-capture value to register as a threaded state
  // value at all — a shorter token (e.g. this repo's own structural-only
  // drill-down fixtures use 6-char tokens) never gets indexed, so the
  // downstream request would silently fall back to an unrelated payload
  // accessor instead of threading r1's actual produced value.
  priceToken: `price-token-${sku}`,
  prices: [{ sku, amount: 19.99 }],
});
const HISTORY_BODY_FOR = (sku: string): { history: unknown[] } => ({
  history: [{ sku, amount: 18.5, asOf: "2024-11-01" }],
});

// Terminal response carries no array field at all — richer (3 primitive
// fields) than the pricing hop's single `priceToken`, so computeFoldChain
// must recognize it as the chain's genuine terminal per-item response even
// though it is a flat object, not an array (the multi-hop counterpart to
// bugfix-001's single-hop flat-object fix).
const FLAT_HISTORY_BODY_FOR = (
  amount: number
): { amount: number; asOf: string; status: string } => ({
  amount,
  asOf: "2024-11-01",
  status: "confirmed",
});

/**
 * Builds the same primary-search + 2-hop chained-drill-down capture shape as
 * `buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps` in
 * recon-generate-multicall-fixture.ts (structural detection coverage), but
 * with a `priceToken` long enough to actually thread through the real
 * `indexStateValues` / `compileActionSteps` pipeline at runtime.
 */
function buildRecordedChainedDrillDownCaptures(): ReturnType<typeof buildCapture>[] {
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
      responseBody: PRICING_BODY_FOR("sku-a"),
      timestamp: "2024-11-15T00:00:01Z",
    }),
    buildCapture({
      url: PRICE_HISTORY_URL,
      requestPostData: `{"priceToken":"${PRICING_BODY_FOR("sku-a").priceToken}"}`,
      responseBody: HISTORY_BODY_FOR("sku-a"),
      timestamp: "2024-11-15T00:00:02Z",
    }),
  ];
}

/**
 * Same shape as `buildRecordedChainedDrillDownCaptures` but the terminal
 * chain step's recorded response is a flat object instead of an
 * array-wrapping one, so the recorded fixture itself proves the plan is
 * built from a genuine flat-object terminal, not merely executed against
 * one at stub time.
 */
function buildRecordedChainedDrillDownCapturesWithFlatTerminal(): ReturnType<
  typeof buildCapture
>[] {
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
      responseBody: PRICING_BODY_FOR("sku-a"),
      timestamp: "2024-11-15T00:00:01Z",
    }),
    buildCapture({
      url: PRICE_HISTORY_URL,
      requestPostData: `{"priceToken":"${PRICING_BODY_FOR("sku-a").priceToken}"}`,
      responseBody: FLAT_HISTORY_BODY_FOR(18.5),
      timestamp: "2024-11-15T00:00:02Z",
    }),
  ];
}

/**
 * Stubs `fetch` to answer the primary search call once, then each chain
 * step's call once per primary item, matched by request body content rather
 * than call order — the fold loop's per-item iteration order isn't asserted
 * here, only that each item's own chain calls thread its own sku through.
 */
function stubChainedFetch(): void {
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const responseBody = (() => {
      if (requestBody === null || typeof requestBody.page === "number") return SEARCH_BODY;
      if (typeof requestBody.sku === "string") return PRICING_BODY_FOR(requestBody.sku);
      if (typeof requestBody.priceToken === "string") {
        const sku = requestBody.priceToken.replace("price-token-", "");
        return HISTORY_BODY_FOR(sku);
      }
      throw new Error(`stubChainedFetch: unrecognized request body ${JSON.stringify(requestBody)}`);
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

/**
 * Same request-routing as `stubChainedFetch`, except the price-history hop
 * answers with a flat per-item object (no array field) whose `amount`
 * varies by sku, so a wrong per-item merge (e.g. always the first fetched
 * item's data) is distinguishable from a correct one.
 */
function stubChainedFetchWithFlatTerminal(): void {
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const responseBody = (() => {
      if (requestBody === null || typeof requestBody.page === "number") return SEARCH_BODY;
      if (typeof requestBody.sku === "string") return PRICING_BODY_FOR(requestBody.sku);
      if (typeof requestBody.priceToken === "string") {
        const sku = requestBody.priceToken.replace("price-token-", "");
        return FLAT_HISTORY_BODY_FOR(sku === "sku-a" ? 18.5 : 22.0);
      }
      throw new Error(
        `stubChainedFetchWithFlatTerminal: unrecognized request body ${JSON.stringify(requestBody)}`
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

describe("recon-generate chained drill-down fold executeHttp — generated-and-run integration guard", () => {
  it("threads each chain step's produced value into the next call and folds the terminal chain response onto the primary item, at runtime", async () => {
    const captures = buildRecordedChainedDrillDownCaptures();
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;

    // Mirrors the real pipeline (recon-generate.ts's orchestrator, not a raw
    // fixture step list): `compileActionSteps` is what actually populates
    // each step's `produces[]` — including r1's `priceToken`, threaded from
    // its own response into r2's request. Skipping this and feeding raw
    // captures straight to `emitMultiStepExecuteHttp` (as the existing
    // body.toContain() assertions in recon-generate.test.ts do) never
    // exercises that threading and would silently pass on generated code
    // that resolves `payload.priceToken` (undefined at runtime) instead of
    // the produced value.
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

    stubChainedFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toEqual([
      { sku: "sku-a", amount: 18.5, asOf: "2024-11-01" },
      { sku: "sku-b", amount: 18.5, asOf: "2024-11-01" },
    ]);
    // The intermediate chain step's own field never lands on the folded
    // item — only the chain's TERMINAL step's field does.
    expect(data.results?.[0]).not.toHaveProperty("priceToken");

    // One primary call, plus one call per chain step (2) per primary item (2).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2 * 2);
  });

  it("folds a flat-object chain terminal onto the primary item, at runtime", async () => {
    const captures = buildRecordedChainedDrillDownCapturesWithFlatTerminal();
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;

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

    // The generated code must reference the terminal chain step's response
    // directly as a merge candidate, not run array-only `.find()` machinery
    // over a value that is a plain object at runtime.
    expect(body).toContain("Object.assign(item, foldMatch ?? {});");
    expect(body).not.toContain("const foldMatches = ");

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubChainedFetchWithFlatTerminal();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toEqual([
      { sku: "sku-a", amount: 18.5, asOf: "2024-11-01", status: "confirmed" },
      { sku: "sku-b", amount: 22.0, asOf: "2024-11-01", status: "confirmed" },
    ]);
    // The intermediate chain step's own field never lands on the folded
    // item — only the chain's TERMINAL step's fields do.
    expect(data.results?.[0]).not.toHaveProperty("priceToken");

    // One primary call, plus one call per chain step (2) per primary item (2).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2 * 2);
  });
});
