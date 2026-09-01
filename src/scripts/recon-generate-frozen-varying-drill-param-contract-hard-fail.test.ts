import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitContractTs,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
} from "@/scripts/recon-generate";

const BASE = "https://api.example.com";

/**
 * Same coverage as
 * recon-generate-frozen-varying-drill-param-hard-fail.test.ts, but for
 * `emitContractTs`'s `parameterizeUrl` — the sibling emitter
 * `assertNoFrozenVaryingDrillParams` is shared with, per
 * docs/recon-generate-nested-fold-flatmaps-away-the-parent-so-drill-params-freeze.md
 * suggested fix #2.
 */

function searchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/search?page=1`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function pricingDrillCapture(sku: string, region: string, ts: string): unknown {
  return {
    timestamp: ts,
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/pricing/?sku=${sku}&region=${region}`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { results: [{ sku, amount: 19.99 }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/pricing/",
  resultsPath: "results",
  joinFields: ["sku"],
};

function buildActionSteps(captures: unknown[]): ReturnType<typeof compileActionSteps> {
  const actionCaptures = extractGraphQLActionSequence(captures as never[], null, SPEC);
  const stateIndex = indexStateValues(
    captures as never[],
    new Set(),
    new Set(actionCaptures.map((a) => a.index))
  );
  return compileActionSteps(actionCaptures, stateIndex);
}

function buildContract(actionSteps: ReturnType<typeof compileActionSteps>): string {
  const primary = searchCapture() as { responseBody: unknown };
  return emitContractTs({
    siteId: "frozen-varying-drill-param-contract-test",
    pascal: "FrozenVaryingDrillParamContractTest",
    baseUrl: BASE,
    baseHeaders: {},
    minTime: 100,
    safeRps: 10,
    responseBody: primary.responseBody,
    gql: false,
    gqlQuery: null,
    endpointPath: "/catalog/search",
    gqlOperationName: null,
    gqlVariables: null,
    auxFiles: [],
    actionSteps,
    foldReturnSpec: SPEC,
  });
}

describe("emitContractTs — frozen-but-varying drill param hard fail", () => {
  it("throws naming the query param when the run's own captures prove it varies and no field threads it", () => {
    const actionSteps = buildActionSteps([
      searchCapture(),
      pricingDrillCapture("sku-a", "us", "2024-01-01T00:00:01Z"),
      pricingDrillCapture("sku-b", "eu", "2024-01-01T00:00:02Z"),
    ]);
    expect(() => buildContract(actionSteps)).toThrow(/region/);
  });

  it("does not throw when the frozen param is identical across every capture of the endpoint", () => {
    const actionSteps = buildActionSteps([
      searchCapture(),
      pricingDrillCapture("sku-a", "us", "2024-01-01T00:00:01Z"),
      pricingDrillCapture("sku-b", "us", "2024-01-01T00:00:02Z"),
    ]);
    expect(() => buildContract(actionSteps)).not.toThrow();
  });
});
