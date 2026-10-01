import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Regression coverage for
 * recon-generate-emitMultiStepExecuteHttp-page-field-variance-false-positive-on-real-pagination.md:
 * a drill-down body field that varies across same-endpoint captures is not an
 * unexplained ambiguity when its variance is explained in exact lockstep by a
 * correlated sibling field — the pagination-sequence shape from the report,
 * minimized with generic `page`/`pageHistory` fixture names (no real
 * plugin/site vocabulary).
 */

const SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/pricing/",
  resultsPath: "results",
  joinFields: ["sku"],
};

/** A search capture plus four same-endpoint drill captures: the first three
 * join distinct item ids with body `{page:1, pageHistory:false}`, and the
 * fourth repeats the third capture's item id with body `{page:2,
 * pageHistory:true}` — `page`'s variance is fully explained by `pageHistory`
 * moving in exact lockstep with it. */
function buildLockstepCorrelatedPaginationSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ sku: "sku-a" }, { sku: "sku-b" }, { sku: "sku-c" }],
      },
      timestamp: "2024-04-01T00:00:00Z",
      method: "GET",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/pricing/?sku=sku-a",
      requestPostData: '{"page":1,"pageHistory":false}',
      responseBody: { results: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
      method: "GET",
    }),
    buildStep("r2", {
      url: "https://api.example.com/catalog/pricing/?sku=sku-b",
      requestPostData: '{"page":1,"pageHistory":false}',
      responseBody: { results: [{ sku: "sku-b", amount: 24.99 }] },
      timestamp: "2024-04-01T00:00:02Z",
      method: "GET",
    }),
    buildStep("r3", {
      url: "https://api.example.com/catalog/pricing/?sku=sku-c",
      requestPostData: '{"page":1,"pageHistory":false}',
      responseBody: { results: [{ sku: "sku-c", amount: 29.99 }] },
      timestamp: "2024-04-01T00:00:03Z",
      method: "GET",
    }),
    buildStep("r4", {
      url: "https://api.example.com/catalog/pricing/?sku=sku-c",
      requestPostData: '{"page":2,"pageHistory":true}',
      responseBody: { results: [{ sku: "sku-c", amount: 29.99 }] },
      timestamp: "2024-04-01T00:00:04Z",
      method: "GET",
    }),
  ];
}

function emit(steps: MulticallFixtureStep[], foldReturnSpec: FoldReturnSpec | null): string {
  return emitMultiStepExecuteHttp(
    steps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
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
}

describe("emitMultiStepExecuteHttp — lockstep-correlated pagination body field", () => {
  it("does not throw when a varying body field moves in exact lockstep with a correlated sibling field", () => {
    expect(() => emit(buildLockstepCorrelatedPaginationSteps(), SPEC)).not.toThrow();
  });

  it("emits a consistent page/pageHistory pairing from one of the captures it chose to freeze", () => {
    const body = emit(buildLockstepCorrelatedPaginationSteps(), SPEC);
    const sawBaselinePairing = body.includes('"page":1,"pageHistory":false');
    const sawDivergentPairing = body.includes('"page":2,"pageHistory":true');
    expect(sawBaselinePairing || sawDivergentPairing).toBe(true);
  });
});
