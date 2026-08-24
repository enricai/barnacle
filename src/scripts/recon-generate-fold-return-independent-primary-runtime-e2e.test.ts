import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallTwoIndependentPrimariesSecondHeaderThreadedActionSteps } from "@/scripts/recon-generate-multicall-fixture";

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

const VENDOR_CONTRACTS_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/vendors/contracts/",
  resultsPath: "vendors",
  drillResultsPath: "contracts",
  joinFields: ["vendorId"],
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

/** Stubs `fetch` to answer each of the two independent primary search calls
 * with their own response, then routes every drill call by inspecting either
 * the request's own JSON body (the structural products/reviews pair, joined
 * on `productId`) or its `X-Vendor-Id` header (the spec-only vendors/
 * contracts pair, whose join never appears in the request body at all) —
 * proving both the structurally-detected loop and the spec-only-resolved
 * loop each re-issue their own correctly parameterized per-item calls at
 * runtime, with no cross-contamination between the two. */
function stubIndependentPrimariesFetch(): void {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const requestBody = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null;
    if (typeof requestBody?.productId === "string") {
      const response = REVIEWS_RESPONSES_BY_PRODUCT_ID[requestBody.productId];
      if (!response) {
        throw new Error(
          `stubIndependentPrimariesFetch: no reviews fixture for productId "${requestBody.productId}"`
        );
      }
      return jsonResponse(response);
    }
    const vendorId = init?.headers ? new Headers(init.headers).get("X-Vendor-Id") : null;
    if (typeof vendorId === "string") {
      const response = CONTRACTS_RESPONSES_BY_VENDOR_ID[vendorId];
      if (!response) {
        throw new Error(
          `stubIndependentPrimariesFetch: no contracts fixture for vendorId "${vendorId}"`
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

describe("recon-generate independent structural + spec-only drill-down fold executeHttp — generated-and-run runtime guard", () => {
  it("folds BOTH the structurally-detected primary's drill-down and the spec-only-resolved primary's drill-down, each onto their own items, at runtime", async () => {
    const actionSteps = buildMulticallTwoIndependentPrimariesSecondHeaderThreadedActionSteps();
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
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      new Map(),
      new Map(),
      VENDOR_CONTRACTS_SPEC
    );

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubIndependentPrimariesFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({
      BaseUrl: "https://api.example.com",
      page: 1,
      lookup: true,
    });

    // Without bugfix-001's fix, `resolveFoldPlan` discarded the spec's plan
    // entirely once the structural heuristic had already resolved the
    // unrelated products/reviews pair, so `vendors` would come back
    // unfolded (no `contractId`). Both primaries' own drill-downs must land
    // here, proving the fix at the executed-code level, not just on the
    // FoldPlan object.
    expect(result.data).toEqual({
      products: [
        { productId: "p1", rating: 5 },
        { productId: "p2", rating: 3 },
      ],
      vendors: [
        { vendorId: "v1", contractId: "c1" },
        { vendorId: "v2", contractId: "c2" },
      ],
    });

    // Two primary searches, plus one drill call per item (2 products + 2
    // vendors) — no extra or missing calls from either independent loop.
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(2 + 2 + 2);
  });
});
