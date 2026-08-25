import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallStructuralPlusSpecOnlySameStepActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_RESPONSE_BODY = {
  products: [{ sku: "sku-a" }],
  vendors: [{ vendorId: "v1" }],
};
const PRICES_RESPONSE_BODY = { prices: [{ sku: "sku-a", amount: 9.99 }] };
const CONTRACTS_RESPONSE_BODY = { contracts: [{ vendorId: "v1", contractId: "c1" }] };

const VENDOR_CONTRACTS_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/vendors/detail",
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

/** Stubs `fetch` to answer the single primary search, then routes the two
 * drill calls: the structurally-detected pricing call by its query string,
 * and the spec-only vendor-detail call by its `X-Vendor-Id` header — the
 * join value never appears anywhere the structural heuristic scans. */
function stubStructuralPlusSpecOnlyFetch(): void {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/catalog/pricing")) {
      return jsonResponse(PRICES_RESPONSE_BODY);
    }
    const vendorId = init?.headers ? new Headers(init.headers).get("X-Vendor-Id") : null;
    if (typeof vendorId === "string") {
      if (vendorId !== "v1") {
        throw new Error(
          `stubStructuralPlusSpecOnlyFetch: no contracts fixture for vendorId "${vendorId}"`
        );
      }
      return jsonResponse(CONTRACTS_RESPONSE_BODY);
    }
    return jsonResponse(SEARCH_RESPONSE_BODY);
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate spec-only drill-down fold onto a second, already-structurally-consumed primary step — generated-and-run runtime guard", () => {
  it("folds the spec-targeted vendors[] items with contractId, alongside the structurally-folded products[] items, at runtime", async () => {
    const actionSteps = buildMulticallStructuralPlusSpecOnlySameStepActionSteps();
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

    stubStructuralPlusSpecOnlyFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({
      BaseUrl: "https://api.example.com",
      page: 1,
      lookup: true,
    });

    // Before the fix, mergeSpecPlanOntoSamePrimary keyed its consumed-index
    // check off primaryStepIndex alone, so the spec's plan for `vendors` —
    // anchored on the SAME step 0 the structural heuristic already resolved
    // `products` from — was wrongly treated as already consumed and dropped,
    // leaving `vendors` unfolded (no `contractId`).
    expect(result.data).toEqual({
      products: [{ sku: "sku-a", amount: 9.99 }],
      vendors: [{ vendorId: "v1", contractId: "c1" }],
    });

    // One primary search, one pricing drill call, one vendor-detail drill call.
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(3);
  });
});
