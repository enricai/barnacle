import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallSingleShotSearchHeuristicAndSpecTwoTargetActionSteps } from "@/scripts/recon-generate-multicall-fixture";

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
const STOCK_RESPONSES_BY_ITEM_ID: Record<string, { stock: { itemId: string; qty: number }[] }> = {
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
 * then routes every subsequent call to the pricing fixture by inspecting the
 * request's own JSON body (heuristically detectable) or to the stock fixture
 * by inspecting the `X-Item-Id` request HEADER (only resolvable via a
 * flow-declared foldReturn spec) — proving the fold loop re-issues both an
 * auto-detected and a spec-declared drill call per item, and merges both. */
function stubHeuristicAndSpecDrillsFetch(): void {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/catalog/pricing/")) {
      const requestBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      const sku = typeof requestBody?.sku === "string" ? requestBody.sku : null;
      const response = sku === null ? undefined : PRICING_RESPONSES_BY_SKU[sku];
      if (!response) {
        throw new Error(`stubHeuristicAndSpecDrillsFetch: no pricing fixture for sku "${sku}"`);
      }
      return jsonResponse(response);
    }
    if (url.includes("/catalog/stock/")) {
      const headers = new Headers(init?.headers);
      const itemId = headers.get("X-Item-Id");
      const response = itemId === null ? undefined : STOCK_RESPONSES_BY_ITEM_ID[itemId];
      if (!response) {
        throw new Error(
          `stubHeuristicAndSpecDrillsFetch: no stock fixture for X-Item-Id "${itemId}"`
        );
      }
      return jsonResponse(response);
    }
    return jsonResponse(SEARCH_RESPONSE_BODY);
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate drill-down fold executeHttp — mixed heuristic+spec source runtime guard", () => {
  it("folds fields from BOTH the heuristic pricing drill and the spec-declared stock drill onto EVERY primary item, at runtime", async () => {
    const actionSteps = buildMulticallSingleShotSearchHeuristicAndSpecTwoTargetActionSteps();
    const inputBody = JSON.parse(actionSteps[0]!.capture.requestPostData ?? "null") as unknown;
    const foldReturnSpec: FoldReturnSpec = {
      endpointPattern: "/catalog/stock/",
      resultsPath: "results",
      joinFields: ["itemId"],
    };

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
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      new Map(),
      new Map(),
      foldReturnSpec
    );

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubHeuristicAndSpecDrillsFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    expect(result.data).toEqual({
      results: [
        { sku: "sku-a", itemId: "item-a", amount: 19.99, qty: 7 },
        { sku: "sku-b", itemId: "item-b", amount: 24.99, qty: 3 },
      ],
    });
    // One primary call, plus one heuristic pricing call and one spec-declared
    // stock call per primary item.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2 * 2);
  });
});
