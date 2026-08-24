import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallSingleShotSearchDrillDownNoDecoyActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_RESPONSE_BODY = {
  results: [{ sku: "sku-a" }, { sku: "sku-b" }],
};
const PRICING_RESPONSES_BY_SKU: Record<string, { prices: { sku: string; amount: number }[] }> = {
  "sku-a": { prices: [{ sku: "sku-a", amount: 19.99 }] },
  "sku-b": { prices: [{ sku: "sku-b", amount: 24.99 }] },
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

/** Stubs `fetch` to answer the primary search call with `SEARCH_RESPONSE_BODY`,
 * then answer every subsequent drill-down call by reading the `sku` out of the
 * request's own JSON body and returning that item's pricing response — proving
 * the fold loop re-issues a distinct, correctly-parameterized call per item
 * rather than replaying the one call it captured. */
function stubPerItemDrillFetch(): void {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.includes("/catalog/pricing/")) {
      return jsonResponse(SEARCH_RESPONSE_BODY);
    }
    const { sku } = JSON.parse(String(init?.body)) as { sku: string };
    const response = PRICING_RESPONSES_BY_SKU[sku];
    if (!response) {
      throw new Error(`stubPerItemDrillFetch: no pricing fixture for sku "${sku}"`);
    }
    return jsonResponse(response);
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate drill-down fold executeHttp — generated-and-run runtime guard", () => {
  it("folds the drilled field onto EVERY primary item, not just the first", async () => {
    const actionSteps = buildMulticallSingleShotSearchDrillDownNoDecoyActionSteps();
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

    stubPerItemDrillFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    expect(result.data).toEqual({
      results: [
        { sku: "sku-a", amount: 19.99 },
        { sku: "sku-b", amount: 24.99 },
      ],
    });
    // One primary call plus one drill-down call per primary item.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });
});
