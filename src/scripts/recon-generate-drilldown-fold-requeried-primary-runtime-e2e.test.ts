import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallSingleShotSearchDrillDownRequeriedPrimaryOverlapActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const PAGE_1_SEARCH_RESPONSE_BODY = {
  results: [{ sku: "sku-a", price: 10 }],
};
const PAGE_2_SEARCH_RESPONSE_BODY = {
  results: [{ sku: "sku-a", price: 12 }],
};
const PRICING_RESPONSE_BODY = {
  prices: [{ sku: "sku-a", amount: 19.99 }],
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

/** Stubs `fetch` to answer the two re-queried search calls (`page: 1`/`page: 2`)
 * with their own distinct response — both independently containing the same
 * `sku`, but at a different `price` — and to answer the pricing drill-down
 * call with its own fixture, proving the fold loop at runtime actually
 * re-issues the `page: 2` call and folds onto ITS occurrence rather than
 * replaying/merging onto the stale `page: 1` one. */
function stubRequeriedPrimaryFetch(): void {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/catalog/pricing/")) {
      return jsonResponse(PRICING_RESPONSE_BODY);
    }
    const requestBody = init?.body ? (JSON.parse(String(init.body)) as { page?: number }) : null;
    return requestBody?.page === 2
      ? jsonResponse(PAGE_2_SEARCH_RESPONSE_BODY)
      : jsonResponse(PAGE_1_SEARCH_RESPONSE_BODY);
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate drill-down fold executeHttp — re-queried primary runtime guard", () => {
  it("folds the drilled field onto the freshest re-queried primary occurrence, not the stale one", async () => {
    const actionSteps = buildMulticallSingleShotSearchDrillDownRequeriedPrimaryOverlapActionSteps();
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

    stubRequeriedPrimaryFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    expect(result.data).toEqual({
      results: [{ sku: "sku-a", price: 12, amount: 19.99 }],
    });
    // Two re-queried search calls (page 1 + page 2) plus one drill-down call
    // for the single folded item.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });
});
