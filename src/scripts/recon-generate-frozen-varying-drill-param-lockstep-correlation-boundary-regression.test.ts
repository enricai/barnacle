import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Boundary coverage for the correlated-sibling-field exception added for
 * docs/recon-generate-nested-fold-flatmaps-away-the-parent-so-drill-params-freeze.md:
 * the exception must only suppress the frozen-varying hard fail when a
 * sibling field explains the target field's variance in *exact* lockstep
 * across every same-endpoint capture. A sibling that merely co-varies on
 * most captures but breaks that lockstep on even one must not count as
 * explanation, and a field with no co-varying sibling at all must never be
 * treated as explained.
 */

const SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/pricing/",
  resultsPath: "results",
  joinFields: ["sku"],
};

/** `isPremium` is false,false,true,true and `pageSize` is 1,1,1,2 — on the
 * surface `isPremium` looks correlated (it changes exactly where `pageSize`
 * starts drifting), but it fails to be a true function of `pageSize`: the
 * `isPremium=true` captures map to two different `pageSize` values (1, then
 * 2). This is NOT exact lockstep, so `pageSize` must still be reported as
 * an unexplained frozen-varying ambiguity. */
function buildNearMissCorrelationSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ sku: "sku-a" }, { sku: "sku-b" }, { sku: "sku-c" }, { sku: "sku-d" }],
      },
      timestamp: "2024-04-01T00:00:00Z",
      method: "GET",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/pricing/?sku=sku-a",
      requestPostData: '{"isPremium":false,"pageSize":1}',
      responseBody: { results: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
      method: "GET",
    }),
    buildStep("r2", {
      url: "https://api.example.com/catalog/pricing/?sku=sku-b",
      requestPostData: '{"isPremium":false,"pageSize":1}',
      responseBody: { results: [{ sku: "sku-b", amount: 24.99 }] },
      timestamp: "2024-04-01T00:00:02Z",
      method: "GET",
    }),
    buildStep("r3", {
      url: "https://api.example.com/catalog/pricing/?sku=sku-c",
      requestPostData: '{"isPremium":true,"pageSize":1}',
      responseBody: { results: [{ sku: "sku-c", amount: 29.99 }] },
      timestamp: "2024-04-01T00:00:03Z",
      method: "GET",
    }),
    buildStep("r4", {
      url: "https://api.example.com/catalog/pricing/?sku=sku-d",
      requestPostData: '{"isPremium":true,"pageSize":2}',
      responseBody: { results: [{ sku: "sku-d", amount: 34.99 }] },
      timestamp: "2024-04-01T00:00:04Z",
      method: "GET",
    }),
  ];
}

/** `pageSize` varies (1 then 2) and no other body field varies at all
 * (`isPremium` is `false` on every capture) — a lone unexplained value with
 * zero candidate correlated siblings, which must hard-fail exactly as
 * before the sibling-correlation exception existed. */
function buildNoCorrelatedSiblingSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
      timestamp: "2024-04-01T00:00:00Z",
      method: "GET",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/pricing/?sku=sku-a",
      requestPostData: '{"isPremium":false,"pageSize":1}',
      responseBody: { results: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
      method: "GET",
    }),
    buildStep("r2", {
      url: "https://api.example.com/catalog/pricing/?sku=sku-b",
      requestPostData: '{"isPremium":false,"pageSize":2}',
      responseBody: { results: [{ sku: "sku-b", amount: 24.99 }] },
      timestamp: "2024-04-01T00:00:02Z",
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

describe("emitMultiStepExecuteHttp — lockstep-correlation exception is precise, not a blanket suppression", () => {
  it("still throws naming the body field when a candidate sibling co-varies but breaks exact lockstep on one capture", () => {
    expect(() => emit(buildNearMissCorrelationSteps(), SPEC)).toThrow(/pageSize/);
  });

  it("still throws naming the body field when no other field varies at all", () => {
    expect(() => emit(buildNoCorrelatedSiblingSteps(), SPEC)).toThrow(/pageSize/);
  });
});
