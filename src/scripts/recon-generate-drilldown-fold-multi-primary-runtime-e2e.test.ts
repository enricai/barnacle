import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallTwoIndependentPrimariesActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const PRODUCTS_SEARCH_RESPONSE_BODY = {
  products: [{ productId: "p1" }, { productId: "p2" }],
};
const VENDORS_SEARCH_RESPONSE_BODY = {
  vendors: [{ vendorId: "v1" }, { vendorId: "v2" }],
};
const REVIEWS_RESPONSES_BY_PRODUCT_ID: Record<
  string,
  { reviews: { productId: string; rating: number }[] }
> = {
  p1: { reviews: [{ productId: "p1", rating: 5 }] },
  p2: { reviews: [{ productId: "p2", rating: 3 }] },
};
const CONTRACTS_RESPONSES_BY_VENDOR_ID: Record<
  string,
  { contracts: { vendorId: string; contractId: string }[] }
> = {
  v1: { contracts: [{ vendorId: "v1", contractId: "c1" }] },
  v2: { contracts: [{ vendorId: "v2", contractId: "c2" }] },
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

/** Stubs `fetch` to answer each of the two primary search calls with their
 * own response, then routes every drill call to the reviews or contracts
 * fixture by inspecting the request's own JSON body — proving both
 * independent primary/drill-down loops re-issue their own correctly
 * parameterized calls at runtime, with no cross-contamination between the
 * products loop and the vendors loop. */
function stubTwoIndependentPrimariesFetch(): void {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const requestBody = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null;
    if (typeof requestBody?.productId === "string") {
      const response = REVIEWS_RESPONSES_BY_PRODUCT_ID[requestBody.productId];
      if (!response) {
        throw new Error(
          `stubTwoIndependentPrimariesFetch: no reviews fixture for productId "${requestBody.productId}"`
        );
      }
      return jsonResponse(response);
    }
    if (typeof requestBody?.vendorId === "string") {
      const response = CONTRACTS_RESPONSES_BY_VENDOR_ID[requestBody.vendorId];
      if (!response) {
        throw new Error(
          `stubTwoIndependentPrimariesFetch: no contracts fixture for vendorId "${requestBody.vendorId}"`
        );
      }
      return jsonResponse(response);
    }
    if (url.includes("/catalog/vendors/search")) {
      return jsonResponse(VENDORS_SEARCH_RESPONSE_BODY);
    }
    return jsonResponse(PRODUCTS_SEARCH_RESPONSE_BODY);
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate drill-down fold executeHttp — multi-primary runtime guard", () => {
  it("folds each independent primary's own drill-down onto its own items, at runtime", async () => {
    const actionSteps = buildMulticallTwoIndependentPrimariesActionSteps();
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

    stubTwoIndependentPrimariesFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    // emitMultiStepExecuteHttp's `return { data }` picks the LAST resolved
    // fold plan's primary (see recon-generate.ts's `lastFoldPlan` selection,
    // the same last-wins convention `selectReturnAction` uses) — here the
    // vendors/contracts plan. Both loops still run at runtime (asserted via
    // the fetch call count and per-id routing below), so this proves the
    // vendors plan's own drill-down folded in correctly and picked up NONE
    // of the products plan's `rating` field — i.e. no cross-contamination —
    // even though both loops executed in the same function.
    expect(result.data).toEqual({
      vendors: [
        { vendorId: "v1", contractId: "c1" },
        { vendorId: "v2", contractId: "c2" },
      ],
    });

    // Every drill call the fold loops issued must have been correctly
    // routed and parameterized — a call to the wrong endpoint/body shape
    // would have thrown inside stubTwoIndependentPrimariesFetch instead of
    // resolving, so reaching this point already proves BOTH primary arrays'
    // items drove their own distinct per-item drill call. Pin the exact
    // call graph too: two primary searches, plus one drill call per item
    // (2 products + 2 vendors), with no extra or missing calls.
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(2 + 2 + 2);
    const requestBodies = calls.map(([, init]) =>
      init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    );
    expect(requestBodies.filter((b) => typeof b?.productId === "string")).toEqual([
      { productId: "p1" },
      { productId: "p2" },
    ]);
    expect(requestBodies.filter((b) => typeof b?.vendorId === "string")).toEqual([
      { vendorId: "v1" },
      { vendorId: "v2" },
    ]);
  });
});
