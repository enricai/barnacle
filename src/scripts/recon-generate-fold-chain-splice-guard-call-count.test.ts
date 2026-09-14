import { afterEach, describe, expect, it, vi } from "vitest";
import * as captureFilters from "@/recon/capture-filters";
import {
  emitContractTs,
  emitMultiStepExecuteHttp,
  type FoldReturnSpec,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * `parameterize` (emitMultiStepExecuteHttp) calls `isZeroVarianceRepeatCapture`
 * once each for url, headers, and body per chain step, re-deriving the
 * `actions.map((a) => a.capture)` array every time — O(actions.length) work
 * repeated 3x per chain hop. This asserts the hoisted memo collapses that to
 * one call per distinct chainCapture, regardless of how many of
 * url/headers/body reference it.
 */

const BASE = "https://api.example.com";

const SPEC: FoldReturnSpec = {
  endpointPattern: "/beacon/item-a/verify",
  resultsPath: "results",
  joinFields: ["sku"],
  drillParamBindings: {},
};

function buildChainActions(): [unknown, unknown, unknown] {
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
  return [search, drill, beaconRepeat];
}

describe("fold chain splice guard — isZeroVarianceRepeatCapture call count", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emitMultiStepExecuteHttp calls isZeroVarianceRepeatCapture at most once per distinct chainCapture, not once per url/headers/body call", () => {
    const spy = vi.spyOn(captureFilters, "isZeroVarianceRepeatCapture");
    const [search, drill, beaconRepeat] = buildChainActions();

    emitMultiStepExecuteHttp(
      [search, drill, beaconRepeat] as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      null,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      BASE,
      new Map(),
      new Map()
    );

    const drillCalls = spy.mock.calls.filter(
      ([capture]) => capture === (drill as { capture: unknown }).capture
    );

    // The Pass-1 per-step render (recon-generate.ts ~L5424) checks the same
    // invariant once, independently of the chain re-render — that call is
    // out of this subtask's scope and stays. The chain re-render's own
    // `parameterize` calls url/headers/body 3x per chain step; unmemoized,
    // that's 3 MORE calls for the same chainCapture (4 total). Hoisted to a
    // memo keyed by chainCapture, it collapses to 1 (2 total).
    expect(drillCalls.length).toBeLessThanOrEqual(2);
    expect(spy).toHaveBeenCalled();
  });

  it("emitContractTs calls isZeroVarianceRepeatCapture at most once per distinct chainCapture", () => {
    const spy = vi.spyOn(captureFilters, "isZeroVarianceRepeatCapture");
    const [search, drill, beaconRepeat] = buildChainActions();

    emitContractTs({
      siteId: "fold-chain-splice-guard-call-count-test",
      pascal: "FoldChainSpliceGuardCallCountTest",
      baseUrl: BASE,
      baseHeaders: {},
      minTime: 100,
      safeRps: 10,
      responseBody: (search as { capture: { responseBody: unknown } }).capture.responseBody,
      gql: false,
      gqlQuery: null,
      endpointPath: "/catalog/search",
      gqlOperationName: null,
      gqlVariables: null,
      auxFiles: [],
      actionSteps: [search, drill, beaconRepeat] as unknown as Parameters<
        typeof emitContractTs
      >[0]["actionSteps"],
      foldReturnSpec: SPEC,
    });

    const drillCalls = spy.mock.calls.filter(
      ([capture]) => capture === (drill as { capture: unknown }).capture
    );

    expect(drillCalls.length).toBeLessThanOrEqual(1);
    expect(spy).toHaveBeenCalled();
  });
});
