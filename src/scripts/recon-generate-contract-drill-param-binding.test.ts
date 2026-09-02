import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitContractTs,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
} from "@/scripts/recon-generate";

/**
 * Sibling coverage to
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

const SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/pricing/",
  resultsPath: "results",
  joinFields: ["sku"],
  drillParamBindings: {
    region: { payloadField: "region", type: "string", default: "unset" },
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

describe("emitContractTs — drillParamBindings wired into its own fold parameterize pass", () => {
  it("emits the payload accessor (with default) for a bound drill param that would otherwise freeze a varying value", () => {
    const actionSteps = buildActionSteps([
      searchCapture(),
      pricingDrillCapture("sku-a", "us", "2024-01-01T00:00:01Z"),
      pricingDrillCapture("sku-b", "eu", "2024-01-01T00:00:02Z"),
    ]);

    const contract = buildContract(actionSteps);

    expect(contract).toContain('region=${payload.region ?? "unset"}');
    expect(contract).not.toContain("region=us");
    expect(contract).not.toContain("region=eu");
  });
});
