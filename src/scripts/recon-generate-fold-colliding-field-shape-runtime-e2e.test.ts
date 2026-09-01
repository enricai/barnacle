import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, selectEffectiveResponseBody } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallSingleShotSearchDrillDownSharedKeyDifferentShapeActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_RESPONSE_BODY = {
  results: [{ sku: "sku-a", fees: { value: 5 } }],
};
const PRICING_RESPONSE_BODY = {
  prices: [{ sku: "sku-a", amount: 19.99, fees: { amount: 2, total: 21.99 } }],
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

/** Stubs `fetch` to answer the primary search call with `SEARCH_RESPONSE_BODY`
 * and every drill-down call with `PRICING_RESPONSE_BODY`, whose `fees` shape
 * deliberately collides with — but does not match — the primary's `fees`. */
function stubCollidingFeesFetch(): void {
  const fn = vi.fn(async (url: string) => {
    if (!url.includes("/catalog/pricing/")) {
      return jsonResponse(SEARCH_RESPONSE_BODY);
    }
    return jsonResponse(PRICING_RESPONSE_BODY);
  });
  vi.stubGlobal("fetch", fn);
}

/**
 * Pins the fold-merge fix (`Object.assign(item, foldMatch)` clobbering a
 * primary item's own field with a differently-shaped drill field) on both
 * halves of the pipeline: the generated `executeHttp`'s actual runtime
 * output, and `selectEffectiveResponseBody`'s schema-inference sample for
 * the same fixture. Both must agree that the primary's `fees: { value }`
 * survives — the drill's `fees: { amount, total }` must never win — or the
 * generated `responseSchema` would reject the plugin's own runtime output.
 */
describe("recon-generate fold merge — primary field survives a shared-key/different-shape drill collision", () => {
  const actionSteps = buildMulticallSingleShotSearchDrillDownSharedKeyDifferentShapeActionSteps();

  it("the generated-and-run executeHttp preserves the primary's fees value, not the drill's", async () => {
    const inputBody = JSON.parse(actionSteps[0]!.capture.requestPostData ?? "null") as unknown;

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

    stubCollidingFeesFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    expect(result.data).toEqual({
      results: [{ sku: "sku-a", fees: { value: 5 }, amount: 19.99 }],
    });
  });

  it("selectEffectiveResponseBody's schema-inference sample agrees: fees keeps the primary's shape", () => {
    const effectiveResponseBody = selectEffectiveResponseBody(true, actionSteps, null);
    expect(effectiveResponseBody).toEqual({
      results: [{ sku: "sku-a", fees: { value: 5 }, amount: 19.99 }],
    });
  });
});
