import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallSingleShotSearchTwoIndependentDrillDownsActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_RESPONSE_BODY = {
  results: [
    { sku: "sku-a", itemId: "item-a" },
    { sku: "sku-b", itemId: "item-b" },
  ],
};
const PRICING_RESPONSES_BY_SKU: Record<string, { prices: { sku: string; amount: number }[] }> = {
  "sku-a": { prices: [{ sku: "sku-a", amount: 19.99 }] },
  "sku-b": { prices: [{ sku: "sku-b", amount: 24.99 }] },
};
const INVENTORY_RESPONSES_BY_ITEM_ID: Record<string, { stock: { itemId: string; qty: number }[] }> =
  {
    "item-a": { stock: [{ itemId: "item-a", qty: 7 }] },
    "item-b": { stock: [{ itemId: "item-b", qty: 3 }] },
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
 * then routes every subsequent call to the pricing or inventory fixture by
 * inspecting the request's own JSON body — proving the fold loop re-issues a
 * distinct, correctly-parameterized call to EACH independent drill target
 * per item, rather than replaying just one of them. */
function stubTwoIndependentDrillsFetch(): void {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const requestBody = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null;
    if (!url.includes("/catalog/pricing/") && !url.includes("/catalog/inventory/")) {
      return jsonResponse(SEARCH_RESPONSE_BODY);
    }
    if (typeof requestBody?.sku === "string") {
      const response = PRICING_RESPONSES_BY_SKU[requestBody.sku];
      if (!response) {
        throw new Error(
          `stubTwoIndependentDrillsFetch: no pricing fixture for sku "${requestBody.sku}"`
        );
      }
      return jsonResponse(response);
    }
    if (typeof requestBody?.itemId === "string") {
      const response = INVENTORY_RESPONSES_BY_ITEM_ID[requestBody.itemId];
      if (!response) {
        throw new Error(
          `stubTwoIndependentDrillsFetch: no inventory fixture for itemId "${requestBody.itemId}"`
        );
      }
      return jsonResponse(response);
    }
    throw new Error(
      `stubTwoIndependentDrillsFetch: unrecognized request body ${JSON.stringify(requestBody)}`
    );
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate drill-down fold executeHttp — multi-target runtime guard", () => {
  it("folds fields from BOTH independent drill-downs onto EVERY primary item, at runtime", async () => {
    const actionSteps = buildMulticallSingleShotSearchTwoIndependentDrillDownsActionSteps();
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

    stubTwoIndependentDrillsFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    expect(result.data).toEqual({
      results: [
        { sku: "sku-a", itemId: "item-a", amount: 19.99, qty: 7 },
        { sku: "sku-b", itemId: "item-b", amount: 24.99, qty: 3 },
      ],
    });
    // One primary call, plus one call per independent drill target (2) per primary item (2).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2 * 2);
  });
});
