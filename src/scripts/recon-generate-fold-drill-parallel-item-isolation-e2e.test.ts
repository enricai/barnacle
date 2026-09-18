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

const ITEM_COUNT = 10;
const FAILING_SKU = "sku-5";
// Artificial per-call latency: long enough that a genuinely sequential
// (one-request-at-a-time) loop could never observe more than one in-flight
// request at once inside its window, but short enough to keep the test fast.
const CALL_LATENCY_MS = 20;

const skus = Array.from({ length: ITEM_COUNT }, (_, i) => `sku-${i}`);
const SEARCH_BODY = { results: skus.map((sku) => ({ sku })) };
const PRICING_BODY_FOR = (sku: string): { prices: unknown[] } => ({
  prices: [{ sku, amount: 19.99 }],
});

/**
 * Builds the same single-hop search + per-item pricing drill-down shape as
 * `buildMulticallSingleShotSearchDrillDownActionSteps`, but with 10 primary
 * items instead of 2 — enough for a timing-based assertion to distinguish a
 * genuinely concurrent per-item fetch from a sequential one.
 */
function buildRecordedSearchDrillDownCaptures(): ReturnType<typeof buildCapture>[] {
  return [
    buildCapture({
      url: SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: SEARCH_BODY,
      timestamp: "2024-11-15T00:00:00Z",
    }),
    buildCapture({
      url: PRICING_URL,
      requestPostData: '{"sku":"sku-0"}',
      responseBody: PRICING_BODY_FOR("sku-0"),
      timestamp: "2024-11-15T00:00:01Z",
    }),
  ];
}

/**
 * Stubs `fetch`: the search call resolves immediately, every pricing call
 * takes `CALL_LATENCY_MS` to resolve (so overlap between calls is
 * observable), and `FAILING_SKU`'s own pricing call 403s (a non-retryable
 * bot-challenge abort in `createHttpClient`) instead of resolving — proving
 * that one item's rejected fetch doesn't prevent the other items' fetches,
 * already in flight or not yet started, from completing and merging.
 * `maxInFlight` is filled in with the highest number of pricing calls this
 * stub ever saw outstanding at once.
 */
function stubSearchDrillDownFetch(maxInFlight: { value: number }): void {
  let inFlight = 0;
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (requestBody === null || typeof requestBody.page === "number") {
      return Promise.resolve({
        status: 200,
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify(SEARCH_BODY)),
        headers: new Headers(),
      });
    }
    const sku = requestBody.sku as string;
    inFlight++;
    maxInFlight.value = Math.max(maxInFlight.value, inFlight);
    return new Promise((resolve) => {
      setTimeout(() => {
        inFlight--;
        if (sku === FAILING_SKU) {
          resolve({
            status: 403,
            ok: false,
            text: vi.fn().mockResolvedValue(JSON.stringify({ error: "forbidden" })),
            headers: new Headers(),
          });
          return;
        }
        resolve({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify(PRICING_BODY_FOR(sku))),
          headers: new Headers(),
        });
      }, CALL_LATENCY_MS);
    });
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate fold/drill per-item loop — parallel dispatch with per-item failure isolation", () => {
  it("emits a Promise.allSettled-based per-item loop, issues every item's drill fetch concurrently, and folds every non-failing item's data even though one item's fetch rejects", async () => {
    const captures = buildRecordedSearchDrillDownCaptures();
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

    // The emitted per-item loop issues its drill fetches through
    // Promise.allSettled — not a bare `for (const item of foldItems) { await
    // ... }` with no isolation.
    expect(body).toContain("Promise.allSettled(");
    expect(body).toMatch(/foldItems\)\.map\(async \(item\) => \{/);

    const limiter = new Bottleneck({ maxConcurrent: ITEM_COUNT, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    const maxInFlight = { value: 0 };
    stubSearchDrillDownFetch(maxInFlight);

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    // The whole call succeeds — one item's rejected fetch doesn't throw out
    // of the loop and fail every other already-successful item's data too.
    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toHaveLength(ITEM_COUNT);

    const bySku = new Map((data.results ?? []).map((item) => [item.sku as string, item]));
    for (const sku of skus) {
      if (sku === FAILING_SKU) {
        // The failing item is neither omitted nor able to abort the batch —
        // it just never receives the merged pricing data.
        expect(bySku.get(sku)).toEqual({ sku });
        continue;
      }
      expect(bySku.get(sku)).toEqual({ sku, amount: 19.99 });
    }

    // Call-order/timing evidence that the per-item fetches actually ran
    // concurrently, not one at a time: a sequential loop could never have
    // more than one pricing call outstanding within CALL_LATENCY_MS.
    expect(maxInFlight.value).toBeGreaterThan(1);

    // One primary call, plus one pricing call per item.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + ITEM_COUNT);
  });
});
