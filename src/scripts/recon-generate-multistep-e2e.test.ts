import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallHeterogeneousActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const TOGGLES_BODY = [{ name: "feature-a", enabled: true }];
const AUTHZ_BODY = { result: "anonymous", successful: true };
const PRODUCTS_PAGE_1_BODY = {
  totalPages: 5,
  totalAvailableListings: 699,
  products: [{ productId: "p1" }],
};
const PRODUCTS_PAGE_2_BODY = {
  totalPages: 5,
  totalAvailableListings: 699,
  products: [{ productId: "p2" }],
};

/** Stubs `fetch` to answer the fixture's four calls, in call order, with each
 * call's own real-shaped captured body — the exact heterogeneous-shape
 * condition G2 collapsed onto one client-wide schema. */
function stubSequentialFetch(bodies: unknown[]): void {
  const fn = vi.fn();
  for (const body of bodies) {
    fn.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify(body)),
      headers: new Headers(),
    });
  }
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate multi-call executeHttp — generated-and-run integration guard", () => {
  it("runs all three calls in order and returns the inventory body, not the last-emitted binding's body", async () => {
    const actionSteps = buildMulticallHeterogeneousActionSteps();
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

    // Matches what emitContractTs wires at module scope: one client-wide
    // schema (z.unknown() for multi-step flows) plus the per-call `schema:`
    // override G2 threads onto every httpClient(...) call in `body`.
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubSequentialFetch([TOGGLES_BODY, AUTHZ_BODY, PRODUCTS_PAGE_1_BODY, PRODUCTS_PAGE_2_BODY]);

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 2 });

    const data = result.data as { totalAvailableListings?: unknown; products?: unknown[] };
    expect(typeof data.totalAvailableListings).toBe("number");
    expect(Array.isArray(data.products) && data.products.length > 0).toBe(true);
    expect(data).toEqual(PRODUCTS_PAGE_2_BODY);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
  });
});
