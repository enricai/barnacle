import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Regression coverage for
 * docs/recon-generate-nested-fold-flatmaps-away-the-parent-so-drill-params-freeze.md
 * suggested fix #2: a drill param that's frozen as a literal (unexplained by
 * any threaded field) must not be emitted silently when the run's own
 * captures prove it varies across items of the same drill endpoint pattern.
 */

const SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/pricing/",
  resultsPath: "results",
  joinFields: ["sku"],
};

/** Two drill captures of the same endpoint, both threading `sku` normally,
 * but each carrying a different `region` value that no threaded field (item
 * or ancestor) explains — the exact `packageCode`/`groupId`/`sailDate`
 * shape from the report, minimized to one unexplained param. */
function buildFrozenVaryingRegionActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
      timestamp: "2024-04-01T00:00:00Z",
      method: "GET",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/pricing/?sku=sku-a&region=us",
      requestPostData: null,
      responseBody: { results: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
      method: "GET",
    }),
    buildStep("r2", {
      url: "https://api.example.com/catalog/pricing/?sku=sku-b&region=eu",
      requestPostData: null,
      responseBody: { results: [{ sku: "sku-b", amount: 24.99 }] },
      timestamp: "2024-04-01T00:00:02Z",
      method: "GET",
    }),
  ];
}

/** Same shape, but `region` is identical on both drill captures — the only
 * difference between it and {@link buildFrozenVaryingRegionActionSteps} is
 * that freezing `region` here is provably correct, not a bug. */
function buildFrozenConstantRegionActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
      timestamp: "2024-04-01T00:00:00Z",
      method: "GET",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/pricing/?sku=sku-a&region=us",
      requestPostData: null,
      responseBody: { results: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
      method: "GET",
    }),
    buildStep("r2", {
      url: "https://api.example.com/catalog/pricing/?sku=sku-b&region=us",
      requestPostData: null,
      responseBody: { results: [{ sku: "sku-b", amount: 24.99 }] },
      timestamp: "2024-04-01T00:00:02Z",
      method: "GET",
    }),
  ];
}

/** Same shape as {@link buildFrozenVaryingRegionActionSteps}, but the
 * varying part moves into the JSON body as a `pageSize` field, and a
 * `tier` sibling field in the same bodies is a true function of it
 * (`"standard"` always pairs with `25`, `"premium"` always pairs with
 * `100`) — the correlated-sibling-field exception should explain this
 * ambiguity instead of treating it as an unexplained frozen-varying bug. */
function buildCorrelatedSiblingBodyFieldSteps(): MulticallFixtureStep[] {
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
      requestPostData: '{"tier":"standard","pageSize":25}',
      responseBody: { results: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
      method: "GET",
    }),
    buildStep("r2", {
      url: "https://api.example.com/catalog/pricing/?sku=sku-b",
      requestPostData: '{"tier":"premium","pageSize":100}',
      responseBody: { results: [{ sku: "sku-b", amount: 24.99 }] },
      timestamp: "2024-04-01T00:00:02Z",
      method: "GET",
    }),
  ];
}

/** Same shape, but `pageSize` varies with no sibling field that explains
 * it (`tier` is identical on both captures) — the hard-fail guard must
 * still throw. */
function buildUnexplainedVaryingBodyFieldSteps(): MulticallFixtureStep[] {
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
      requestPostData: '{"tier":"standard","pageSize":25}',
      responseBody: { results: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
      method: "GET",
    }),
    buildStep("r2", {
      url: "https://api.example.com/catalog/pricing/?sku=sku-b",
      requestPostData: '{"tier":"standard","pageSize":100}',
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

describe("emitMultiStepExecuteHttp — frozen-but-varying drill param hard fail", () => {
  it("throws naming the query param when the run's own captures prove it varies and no field threads it", () => {
    expect(() => emit(buildFrozenVaryingRegionActionSteps(), SPEC)).toThrow(/region/);
  });

  it("does not throw when the frozen param is identical across every capture of the endpoint", () => {
    expect(() => emit(buildFrozenConstantRegionActionSteps(), SPEC)).not.toThrow();
    const body = emit(buildFrozenConstantRegionActionSteps(), SPEC);
    expect(body).toContain("region=us");
  });

  it("does not throw when a varying body field is a deterministic function of a correlated sibling field", () => {
    expect(() => emit(buildCorrelatedSiblingBodyFieldSteps(), SPEC)).not.toThrow();
  });

  it("still throws naming the body field when no sibling field explains why it varies", () => {
    expect(() => emit(buildUnexplainedVaryingBodyFieldSteps(), SPEC)).toThrow(/pageSize/);
  });
});
