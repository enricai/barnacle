import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A two-level nested primary (`products.*.units`, one
 * {@link ARRAY_WILDCARD_SEGMENT} crossing: an ancestor array whose entries
 * each carry their own nested item array) with FOUR leaf units spread
 * unevenly across THREE ancestor products (2 + 1 + 1). The drill call is
 * issued once per ancestor and its response array is shared by every leaf
 * unit under that ancestor (product `p1` has two units, `unit-1`/`unit-2`,
 * matched against the SAME `r1` response) — so a fold-index bug that
 * misaligned a leaf against its ancestor's response array, or that trusted
 * whichever candidate came first, would graft a sibling's price onto the
 * wrong leaf. Each candidate row carries only the declared join field
 * (`unitId`) and that unit's own price — no other shared or structural
 * field the heuristic could key on instead — and every drill response
 * echoes a decoy row (a SIBLING unit's `unitId`/price) ahead of the real
 * match, so only a join correctly keyed on the declared field resolves each
 * leaf to its own data. Because every candidate row carries the declared
 * join field, the emitted `soleCandidateFieldsAbsent` check
 * (recon-generate.ts's emitFoldMatchAndMergeLines) never applies here either
 * — the match must fall through to the declared-key `.find()` comparison.
 */
function buildNestedAncestorFoldActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/available-products/",
      requestPostData: '{"page":1}',
      responseBody: {
        products: [
          {
            productId: "p1",
            units: [{ unitId: "unit-1" }, { unitId: "unit-2" }],
          },
          { productId: "p2", units: [{ unitId: "unit-3" }] },
          { productId: "p3", units: [{ unitId: "unit-4" }] },
        ],
      },
      timestamp: "2024-08-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/available-units/lookup/",
      requestPostData: '{"unitId":"unit-1"}',
      responseBody: {
        errors: [],
        payload: {
          details: [
            { unitId: "unit-2", price: 202 },
            { unitId: "unit-1", price: 101 },
          ],
        },
      },
      timestamp: "2024-08-01T00:00:01Z",
    }),
  ];
}

const NESTED_ANCESTOR_FOLD_SPEC: FoldReturnSpec = {
  endpointPattern: "/available-units/lookup/",
  resultsPath: "products.*.units",
  drillResultsPath: "payload.details",
  joinFields: ["unitId"],
};

const PRICE_BY_UNIT_ID: Record<string, number> = {
  "unit-1": 101,
  "unit-2": 202,
  "unit-3": 303,
  "unit-4": 404,
};

/** Cyclic "next sibling" order used to pick each drill response's decoy row
 * — the row that precedes the real match and that a blind `foldMatches[0]`
 * pick (or a join keyed on the wrong field) would wrongly graft on. */
const DECOY_SIBLING_UNIT_ID: Record<string, string> = {
  "unit-1": "unit-2",
  "unit-2": "unit-3",
  "unit-3": "unit-4",
  "unit-4": "unit-1",
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

/** Stubs `fetch` to answer the primary search with the 4-leaf/3-ancestor
 * fixture, then answer every per-unit drill call by reading `unitId` out of
 * the request body and returning TWO candidate rows: a decoy carrying a
 * sibling unit's `unitId` and price, ahead of the real match for the
 * requested unit. Only a join correctly keyed on the declared `unitId` (not
 * the first candidate, not any other field) resolves to the right row. */
function stubPerUnitNestedAncestorDrillFetch(): void {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.includes("/available-units/lookup/")) {
      return jsonResponse({
        products: [
          {
            productId: "p1",
            units: [{ unitId: "unit-1" }, { unitId: "unit-2" }],
          },
          { productId: "p2", units: [{ unitId: "unit-3" }] },
          { productId: "p3", units: [{ unitId: "unit-4" }] },
        ],
      });
    }
    const { unitId } = JSON.parse(String(init?.body)) as { unitId: string };
    const price = PRICE_BY_UNIT_ID[unitId];
    if (price === undefined) {
      throw new Error(`stubPerUnitNestedAncestorDrillFetch: no price fixture for "${unitId}"`);
    }
    const decoyUnitId = DECOY_SIBLING_UNIT_ID[unitId]!;
    const decoyPrice = PRICE_BY_UNIT_ID[decoyUnitId];
    return jsonResponse({
      errors: [],
      payload: {
        details: [
          { unitId: decoyUnitId, price: decoyPrice },
          { unitId, price },
        ],
      },
    });
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate foldReturn declared joinFields — nested ancestor+item runtime guard", () => {
  it("merges every leaf unit across a two-level nested primary with its OWN drilled price, never a sibling's", async () => {
    const actionSteps = buildNestedAncestorFoldActionSteps();
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
      NESTED_ANCESTOR_FOLD_SPEC
    );

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubPerUnitNestedAncestorDrillFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    expect(result.data).toEqual({
      products: [
        {
          productId: "p1",
          units: [
            { unitId: "unit-1", price: 101 },
            { unitId: "unit-2", price: 202 },
          ],
        },
        { productId: "p2", units: [{ unitId: "unit-3", price: 303 }] },
        { productId: "p3", units: [{ unitId: "unit-4", price: 404 }] },
      ],
    });
    // One primary call plus one drill-down call per ancestor product.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
  });
});
