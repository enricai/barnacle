import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

const CATALOG_SEARCH_URL = "https://api.example.com/catalog/search/";
const CATALOG_PRICING_URL = "https://api.example.com/catalog/pricing/";

/**
 * A single-shot search whose one primary item (`sku-a`) is drilled by a
 * request keyed off its own join value, but whose captured drill RESPONSE at
 * generation time held a sibling item's row (`sku-b`) — reproducing the
 * `foldMatches` array being non-empty (so the empty-array early-out doesn't
 * apply) while still containing zero entries that match `sku-a`'s join key.
 */
function buildSingleItemDrillDownSiblingCapturedActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: { results: [{ sku: "sku-a", name: "Widget" }] },
      timestamp: "2025-02-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: { prices: [{ sku: "sku-b", amount: 5.0 }] },
      timestamp: "2025-02-01T00:00:01Z",
    }),
  ];
}

/** Stubs `fetch` to answer the fixture's calls, in call order, with each
 * call's own real-shaped captured body. */
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

describe("recon-generate drill-down fold — non-empty non-matching candidate array runtime guard", () => {
  it("leaves the item untouched instead of grafting an unrelated sibling's fields when no candidate matches its join key", async () => {
    const actionSteps = buildSingleItemDrillDownSiblingCapturedActionSteps();

    const body = emitMultiStepExecuteHttp(
      actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      null,
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

    // The runtime drill call for the sole item (`sku-a`) comes back with a
    // NON-empty `prices[]` array whose only entry belongs to a different sku
    // (`sku-b`) — the wrong-sibling-grafting scenario `foldMatches[0]` used to
    // fall through to.
    stubSequentialFetch([
      { results: [{ sku: "sku-a", name: "Widget" }] },
      { prices: [{ sku: "sku-b", amount: 5.0 }] },
    ]);

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com" });

    expect(result.data).toEqual({
      results: [{ sku: "sku-a", name: "Widget" }],
    });
    // The sibling's distinguishing field (`amount: 5.0`, from sku-b's row)
    // must not have been grafted onto sku-a.
    expect(
      (result.data as { results: Array<Record<string, unknown>> }).results[0]
    ).not.toHaveProperty("amount");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
