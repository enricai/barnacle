import { describe, expect, it } from "vitest";
import { emitContractTs, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Sibling coverage to
 * recon-generate-fold-chain-rerender-zero-variance-url-splice-guard.test.ts,
 * for `emitContractTs`'s own `parameterizeUrl` chain re-render (the second
 * call site the isGenuineVaryingQueryValue guard was threaded into
 * alongside emitMultiStepExecuteHttp's). The action sequence is hand-built
 * (not routed through extractGraphQLActionSequence) because that extractor
 * already drops zero-variance-repeat captures before they'd ever reach a
 * fold chain — this fixture instead reproduces the defensive scenario the
 * guard exists for: a beacon-style capture that reaches the chain re-render
 * regardless of how it got admitted.
 */

const BASE = "https://api.example.com";

const SPEC: FoldReturnSpec = {
  endpointPattern: "/beacon/item-a/verify",
  resultsPath: "results",
  joinFields: ["sku"],
  drillParamBindings: {},
};

function emitBeaconUrl(): string {
  const search = {
    capture: buildCapture({
      url: `${BASE}/catalog/search/`,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [
          { sku: "item-a", tag: "g0" },
          { sku: "item-b", tag: "g1" },
        ],
      },
      timestamp: "2026-01-01T00:00:01Z",
    }),
    varName: "r1",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };
  // The beacon's own opaque path segment ("item-a") coincidentally equals
  // the first fold item's `sku` — the same splice temptation covered on
  // emitMultiStepExecuteHttp's side.
  const drill = {
    capture: buildCapture({
      url: `${BASE}/beacon/item-a/verify?clientId=abc123&siteId=xyz&nonce=1`,
      requestPostData: null,
      method: "GET",
      responseBody: {},
      timestamp: "2026-01-01T00:00:02Z",
    }),
    varName: "r2",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };
  // A second occurrence of the SAME opaque path (only the nonce query key
  // varies) proves the endpoint request-invariant via
  // isZeroVarianceRepeatCapture's two-occurrence + fixed-key requirement.
  const beaconRepeat = {
    capture: buildCapture({
      url: `${BASE}/beacon/item-a/verify?clientId=abc123&siteId=xyz&nonce=2`,
      requestPostData: null,
      method: "GET",
      responseBody: {},
      timestamp: "2026-01-01T00:00:03Z",
    }),
    varName: "r3",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };

  const primaryResponseBody = search.capture.responseBody;
  const contract = emitContractTs({
    siteId: "contract-fold-chain-rerender-zero-variance-test",
    pascal: "ContractFoldChainRerenderZeroVarianceTest",
    baseUrl: BASE,
    baseHeaders: {},
    minTime: 100,
    safeRps: 10,
    responseBody: primaryResponseBody,
    gql: false,
    gqlQuery: null,
    endpointPath: "/catalog/search",
    gqlOperationName: null,
    gqlVariables: null,
    auxFiles: [],
    actionSteps: [search, drill, beaconRepeat],
    foldReturnSpec: SPEC,
  });

  const match = /`([^`]*beacon[^`]*)`/.exec(contract);
  if (!match) throw new Error("beacon url not found in emitted contract");
  return match[1]!;
}

describe("emitContractTs — fold chain re-render zero-variance-repeat URL splice guard", () => {
  it("emits the beacon's exact literal URL with zero interpolation beyond the fixed baseUrl template", () => {
    const url = emitBeaconUrl();

    // emitContractTs always templates the base URL via `${context.baseUrl}`
    // — that is not the splice under test. The rest of the path/query, the
    // part `isGenuineVaryingQueryValue` gates, must be the beacon's exact
    // literal bytes.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on literal "${context.baseUrl}" bytes captured from generator output, not a template literal
    expect(url).toBe("${context.baseUrl}/beacon/item-a/verify?clientId=abc123&siteId=xyz&nonce=1");
  });

  it("never opens an invalidly-nested placeholder beyond the single fixed baseUrl template", () => {
    const url = emitBeaconUrl();

    expect(url).not.toMatch(/\$\{[^}]*\$\{/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching literal "${context.baseUrl}" bytes captured from generator output, not a template literal
    expect(url.replace("${context.baseUrl}", "")).not.toContain("${");
  });
});
