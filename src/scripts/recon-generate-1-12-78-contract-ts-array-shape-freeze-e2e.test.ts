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
 * Pins the `emitContractTs` `parameterizeUrl` call to
 * `assertNoFrozenVaryingDrillParams` against request-body arrays whose
 * element sets differ across captures: element identity, not slot index,
 * decides variance, so a fix applied only to the multi-step emitter's
 * sibling would be caught here.
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

function pricingDrillCapture(
  sku: string,
  body: Record<string, unknown>,
  ts: string,
  query = ""
): unknown {
  return {
    timestamp: ts,
    phase: "browse",
    method: "POST",
    url: `${BASE}/catalog/pricing/${query}`,
    status: 200,
    requestHeaders: { "content-type": "application/json" },
    requestPostData: JSON.stringify({ sku, ...body }),
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

function buildContract(captures: unknown[]): string {
  const actionCaptures = extractGraphQLActionSequence(captures as never[], null, SPEC);
  const stateIndex = indexStateValues(
    captures as never[],
    new Set(),
    new Set(actionCaptures.map((a) => a.index))
  );
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);
  const primary = searchCapture() as { responseBody: unknown };
  return emitContractTs({
    siteId: "contract-ts-array-shape-freeze-test",
    pascal: "ContractTsArrayShapeFreezeTest",
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

describe("emitContractTs — differently shaped request-body arrays", () => {
  it("does not abort or report frozen-varying for mutually exclusive facet array shapes", () => {
    const contract = buildContract([
      searchCapture(),
      pricingDrillCapture(
        "sku-a",
        { filters: ["red;facetId=color", "XL;facetType=size"] },
        "2024-01-01T00:00:01Z"
      ),
      pricingDrillCapture(
        "sku-b",
        { filters: ["M;facetType=size", "red;facetId=color", "x;other=y"] },
        "2024-01-01T00:00:02Z"
      ),
    ]);
    expect(contract.length).toBeGreaterThan(0);
  });

  it("still reaches the guard: a varying query param throws while the array shapes are not named", () => {
    const run = (): string =>
      buildContract([
        searchCapture(),
        pricingDrillCapture(
          "sku-a",
          { filters: ["red;facetId=color", "XL;facetType=size"] },
          "2024-01-01T00:00:01Z",
          "?region=us"
        ),
        pricingDrillCapture(
          "sku-b",
          { filters: ["M;facetType=size", "red;facetId=color", "x;other=y"] },
          "2024-01-01T00:00:02Z",
          "?region=eu"
        ),
      ]);
    expect(run).toThrow(/region/);
    expect(run).not.toThrow(/filters/);
  });
});
