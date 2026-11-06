import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitContractTs,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
} from "@/scripts/recon-generate";

/**
 * POST drill hop body/content-type emit. Sibling coverage to
 * recon-generate-foldreturn-drill-param-binding-runtime-e2e.test.ts, for
 * `emitContractTs`'s own `parameterizeUrl` — it resolves the same
 * `foldReturnSpec` and must not silently skip `applyDrillParamBindings` the
 * way `emitMultiStepExecuteHttp`'s fold parameterize pass does.
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

function postDrill(sku: string, qty: number, ts: string): unknown {
  return {
    ...(pricingDrillCapture(sku, "x", ts) as object),
    method: "POST",
    url: `${BASE}/catalog/stock/`,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ sku, qty }),
  };
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/stock/",
  resultsPath: "results",
  joinFields: ["sku"],
  drillParamBindings: { qty: { payloadField: "quantity", type: "int", default: 1 } },
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
    siteId: "contract-drill-param-binding-test",
    pascal: "ContractDrillParamBindingTest",
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

describe("emitContractTs — POST drill hop", () => {
  it("emits method, content-type and a body with the bound key rewritten", () => {
    const actionSteps = buildActionSteps([
      searchCapture(),
      postDrill("sku-a", 2, "2024-01-01T00:00:01Z"),
      postDrill("sku-b", 3, "2024-01-01T00:00:02Z"),
    ]);
    const contract = buildContract(actionSteps);
    expect(contract).toContain('method: "POST"');
    expect(contract).toContain('"content-type": "application/json"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting emitted source
    expect(contract).toContain('"qty":${payload.quantity ?? 1}');
  });
});
