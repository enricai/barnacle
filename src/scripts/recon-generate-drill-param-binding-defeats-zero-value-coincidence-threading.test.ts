import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitContractTs,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
} from "@/scripts/recon-generate";

/**
 * Regression coverage for the doc's minimal repro: a bound drill param whose
 * captured value (0) coincidentally matches an unrelated item field also
 * equal to 0 must still resolve to the declared payload accessor, not the
 * coincidence-threaded field it happens to share a value with.
 */

const BASE = "https://api.example.com";

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
    responseBody: { results: [{ sku: "sku-a", discount: 0 }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function pricingDrillCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/pricing/?sku=sku-a&count=0`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { results: [{ sku: "sku-a", amount: 19.99 }] },
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
  drillParamBindings: {
    count: { payloadField: "count", type: "int", default: 0 },
  },
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
    siteId: "drill-param-binding-zero-coincidence-test",
    pascal: "DrillParamBindingZeroCoincidenceTest",
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

describe("applyDrillParamBindings — a declared binding overrides coincidence-threading onto a zero-valued neighbor", () => {
  it("emits the payload accessor for the bound param, not the coincidence-threaded item field it shares a value with", () => {
    const actionSteps = buildActionSteps([searchCapture(), pricingDrillCapture()]);

    const contract = buildContract(actionSteps);

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(contract).toContain("count=${payload.count ?? 0}");
    expect(contract).not.toContain("count=0");
    expect(contract).not.toMatch(/count=\$\{[a-zA-Z0-9_.]*\.discount\}/);
  });
});
