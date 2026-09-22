import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildDoubleNestedWildcardDrillDownActionSteps } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Mirrors
 * recon-generate-foldreturn-declared-joinfields-override-structural-heuristic-runtime-e2e.test.ts
 * but the primary results live under a `products.*.itineraries.*.units`
 * `resultsPath` — TWO {@link ARRAY_WILDCARD_SEGMENT} crossings, mirroring the
 * reported 3-level nested array shape — instead of a single flat array. The
 * structural heuristic's own inferred key (`unitCode`) threads through the
 * drill REQUEST; the declared `foldReturn.joinFields: ["unitId"]` is only
 * ever echoed on the drill/primary RESPONSE. Proves the declared key still
 * wins as the emitted join key once resolving the plan requires flattening
 * across two nested wildcard levels, not just one.
 */
const DOUBLE_WILDCARD_SPEC: FoldReturnSpec = {
  endpointPattern: "/available-units/",
  resultsPath: "products.*.itineraries.*.units",
  drillResultsPath: "pricing",
  joinFields: ["unitId"],
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

function stubDoubleNestedWildcardFetch(): void {
  const fn = vi.fn(async (url: string) => {
    if (!url.includes("/available-units/")) {
      return jsonResponse({
        products: [
          {
            productId: "p1",
            itineraries: [
              {
                itineraryId: "it-1",
                units: [{ unitCode: "u-1", unitId: "unit-77" }],
              },
            ],
          },
        ],
      });
    }
    return jsonResponse({ pricing: [{ unitCode: "u-1", unitId: "unit-77", price: 250 }] });
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate foldReturn declared joinFields override — nested double-wildcard resultsPath", () => {
  it("emits the declared joinFields, not the structurally-inferred field, through a two-wildcard resultsPath", () => {
    const actionSteps = buildDoubleNestedWildcardDrillDownActionSteps();
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
      DOUBLE_WILDCARD_SPEC
    );

    expect(body).toContain('m["unitId"]');
    expect(body).not.toContain('m["unitCode"]');
    expect(body.match(/httpClient\(/g)?.length).toBe(2);
  });

  it("folds the declared field's join at runtime across the flattened double-wildcard items", async () => {
    const actionSteps = buildDoubleNestedWildcardDrillDownActionSteps();
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
      DOUBLE_WILDCARD_SPEC
    );

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubDoubleNestedWildcardFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    expect(result.data).toEqual({
      products: [
        {
          productId: "p1",
          itineraries: [
            {
              itineraryId: "it-1",
              units: [{ unitCode: "u-1", unitId: "unit-77", price: 250 }],
            },
          ],
        },
      ],
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
