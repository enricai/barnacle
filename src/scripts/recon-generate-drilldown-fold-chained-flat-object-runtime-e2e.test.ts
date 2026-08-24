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
const PRICING_BODY_FOR = (sku: string): { priceToken: string; sku: string } => ({
  // >= 8 chars: `indexStateValues`' MIN_STATE_VALUE_LENGTH floor requires
  // this length for the recon-capture value to register as a threaded state
  // value at all — a shorter token never gets indexed, so the downstream
  // request would silently fall back to an unrelated payload accessor
  // instead of threading r1's actual produced value.
  priceToken: `price-token-${sku}`,
  sku,
});
const HISTORY_BODY_FOR = (sku: string): { sku: string; amount: number; asOf: string } => ({
  sku,
  amount: 18.5,
  asOf: "2024-11-01",
});

/**
 * Builds the same primary-search + 2-hop chained-drill-down capture shape as
 * `buildRecordedChainedDrillDownCaptures` in
 * recon-generate-drilldown-fold-chained-runtime-e2e.test.ts, but with BOTH
 * chain-hop responses being flat (non-array) objects rather than arrays —
 * combining the chained-threading and flat-object-terminal conditions in one
 * runtime pass.
 */
function buildRecordedChainedFlatObjectDrillDownCaptures(): ReturnType<typeof buildCapture>[] {
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
 * Stubs `fetch` to answer the primary search call once, then each chain
 * step's call once per primary item, matched by request body content rather
 * than call order — the fold loop's per-item iteration order isn't asserted
 * here, only that each item's own chain calls thread its own sku through.
 */
function stubChainedFlatObjectFetch(): void {
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const responseBody = (() => {
      if (requestBody === null || typeof requestBody.page === "number") return SEARCH_BODY;
      if (typeof requestBody.sku === "string") return PRICING_BODY_FOR(requestBody.sku);
      if (typeof requestBody.priceToken === "string") {
        const sku = requestBody.priceToken.replace("price-token-", "");
        return HISTORY_BODY_FOR(sku);
      }
      throw new Error(
        `stubChainedFlatObjectFetch: unrecognized request body ${JSON.stringify(requestBody)}`
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

const STATUS_URL = "https://api.example.com/catalog/status/";
const DETAIL_URL = "https://api.example.com/catalog/detail/";

// The drill step's own response echoes the value present in its OWN
// request (`sku`) alongside a single non-echoed field (`statusToken`) —
// echo-excluded richness is 1. Uncorrected (bugfix-001's regression),
// the echoed `sku` field inflated this baseline to 2, masking a
// genuinely richer later chain terminal below.
const STATUS_BODY_FOR = (sku: string): { sku: string; statusToken: string } => ({
  sku,
  // >= 8 chars, see PRICING_BODY_FOR's comment: `indexStateValues`' floor.
  statusToken: `status-token-${sku}`,
});

// The chained terminal step threads and echoes `statusToken` (excluded
// from its own richness, matching its own request) but carries TWO of
// its own non-echoed fields — strictly more than the drill step's
// echo-excluded richness of 1 — so it must displace the drill step as
// the chain's genuine terminal.
const DETAIL_BODY_FOR = (
  sku: string
): { statusToken: string; detailId: string; quantity: number } => ({
  statusToken: `status-token-${sku}`,
  detailId: `detail-id-${sku}`,
  quantity: 9,
});

/**
 * Builds a primary-search + 2-hop chained-drill-down capture shape where the
 * drill step's response echoes the threaded join value from its own request
 * plus one lightweight field, and the later chained step echoes that same
 * threaded value but carries strictly more of its own data — the runtime
 * counterpart to `chainTerminalItemRichness`'s echo-excluding fix (the
 * uncorrected metric compared the flat-branch candidate's echo-excluded
 * richness against a stale, unexcluded baseline, letting the echoed `sku`
 * field mask this genuinely richer terminal).
 */
function buildRecordedChainedEchoInflatedDrillDownCaptures(): ReturnType<typeof buildCapture>[] {
  return [
    buildCapture({
      url: SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: SEARCH_BODY,
      timestamp: "2024-11-15T00:00:00Z",
    }),
    buildCapture({
      url: STATUS_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: STATUS_BODY_FOR("sku-a"),
      timestamp: "2024-11-15T00:00:01Z",
    }),
    buildCapture({
      url: DETAIL_URL,
      requestPostData: `{"statusToken":"${STATUS_BODY_FOR("sku-a").statusToken}"}`,
      responseBody: DETAIL_BODY_FOR("sku-a"),
      timestamp: "2024-11-15T00:00:02Z",
    }),
  ];
}

/**
 * Stubs `fetch` for the echo-inflated chain: search -> status (keyed by
 * `sku`) -> detail (keyed by the threaded `statusToken`), matched by
 * request body content, not call order.
 */
function stubChainedEchoInflatedFetch(): void {
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const responseBody = (() => {
      if (requestBody === null || typeof requestBody.page === "number") return SEARCH_BODY;
      if (typeof requestBody.sku === "string") return STATUS_BODY_FOR(requestBody.sku);
      if (typeof requestBody.statusToken === "string") {
        const sku = requestBody.statusToken.replace("status-token-", "");
        return DETAIL_BODY_FOR(sku);
      }
      throw new Error(
        `stubChainedEchoInflatedFetch: unrecognized request body ${JSON.stringify(requestBody)}`
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

describe("recon-generate chained flat-object drill-down fold executeHttp — generated-and-run integration guard", () => {
  it("threads each chain step's produced value into the next call and folds the terminal flat-object chain response onto the primary item, at runtime", async () => {
    const captures = buildRecordedChainedFlatObjectDrillDownCaptures();
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

    stubChainedFlatObjectFetch();

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

  it("advances the fold terminal to a later flat-object step whose own data outweighs the drill step's echo-inflated baseline, at runtime", async () => {
    const captures = buildRecordedChainedEchoInflatedDrillDownCaptures();
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

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubChainedEchoInflatedFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toEqual([
      {
        sku: "sku-a",
        statusToken: "status-token-sku-a",
        detailId: "detail-id-sku-a",
        quantity: 9,
      },
      {
        sku: "sku-b",
        statusToken: "status-token-sku-b",
        detailId: "detail-id-sku-b",
        quantity: 9,
      },
    ]);
    // The genuinely richer chained detail step's own fields land on the
    // folded item — proving the terminal advanced past the drill step's
    // echo-inflated baseline instead of stopping there.
    expect(data.results?.[0]).toHaveProperty("detailId", "detail-id-sku-a");
    expect(data.results?.[0]).toHaveProperty("quantity", 9);

    // One primary call, plus one call per chain step (2) per primary item (2).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2 * 2);
  });
});
