import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallSingleShotSearchTwoIndependentArraysActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_RESPONSE_BODY = {
  products: [{ sku: "sku-a" }],
  vendors: [{ vendorId: "v1" }],
};
const PRICING_RESPONSE_BODY = { prices: [{ sku: "sku-a", amount: 9.99 }] };
const VENDOR_DETAIL_RESPONSE_BODY = { contracts: [{ vendorId: "v1", contractId: "c1" }] };

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
 * then routes every subsequent call to the pricing or vendor-detail fixture by
 * URL, proving each of the two structurally-independent arrays on the SAME
 * primary response folds its own drill-down without leaking fields onto the
 * other array's items. */
function stubTwoIndependentArraysFetch(): void {
  const fn = vi.fn(async (url: string) => {
    if (url.includes("/catalog/pricing/")) {
      return jsonResponse(PRICING_RESPONSE_BODY);
    }
    if (url.includes("/catalog/vendors/detail/")) {
      return jsonResponse(VENDOR_DETAIL_RESPONSE_BODY);
    }
    return jsonResponse(SEARCH_RESPONSE_BODY);
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate drill-down fold executeHttp — two independent arrays runtime guard", () => {
  it("folds each independent array's own drill-down onto its own items, at runtime", async () => {
    const actionSteps = buildMulticallSingleShotSearchTwoIndependentArraysActionSteps();
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

    stubTwoIndependentArraysFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    expect(result.data).toEqual({
      products: [{ sku: "sku-a", amount: 9.99 }],
      vendors: [{ vendorId: "v1", contractId: "c1" }],
    });
  });
});
