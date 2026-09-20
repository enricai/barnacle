import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveApplicableFoldPlans } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Mirrors the reported repro: a noise capture and a real-primary capture
 * share the identical structural shape (an object array reachable at the
 * declared `foldReturn.resultsPath`), so `detectDrillDownFoldPlan`'s
 * unconstrained structural scan cannot tell them apart on shape alone and
 * used to resolve whichever one appeared SECOND in the action array. Only
 * the real capture's operation identity matches the emitted-primary anchor
 * passed to `resolveApplicableFoldPlans` (mirroring `emitContractTs`'s
 * single-primary call), so the fix must resolve the same primary regardless
 * of array order.
 */
interface MulticallStep {
  capture: Capture;
  varName: string;
  produces: never[];
  isMultipart: boolean;
  isCrossDomain: boolean;
}

function step(overrides: {
  url: string;
  responseBody: unknown;
  timestamp: string;
  operationName?: string | null;
  query?: string | null;
}): MulticallStep {
  return {
    capture: {
      timestamp: overrides.timestamp,
      phase: "action",
      method: "POST",
      url: overrides.url,
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({ query: overrides.query ?? null, variables: {} }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: overrides.responseBody,
      operationName: overrides.operationName ?? null,
      query: overrides.query ?? null,
      variables: {},
      decodedParams: null,
    },
    varName: "r",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };
}

const PRODUCT_SEARCH_QUERY = "query productSearch { catalog { results { products { id } } } }";
const REAL_SEARCH_URL = "https://api.example.com/catalog/graph";
const NOISE_URL = "https://api.example.com/promo/api/v1/banner";
const DRILL_URL = "https://api.example.com/inventory/api/v1/stock";

function noiseCapture(): MulticallStep {
  return step({
    url: NOISE_URL,
    responseBody: {
      data: { catalog: { results: { products: [{ id: "NOISE1", variants: [{ id: "n1" }] }] } } },
    },
    timestamp: "2024-01-01T00:00:00Z",
  });
}

function realCapture(): MulticallStep {
  return step({
    url: REAL_SEARCH_URL,
    responseBody: {
      data: { catalog: { results: { products: [{ id: "REAL1", variants: [{ id: "r1" }] }] } } },
    },
    timestamp: "2024-01-01T00:00:01Z",
    operationName: "productSearch",
    query: PRODUCT_SEARCH_QUERY,
  });
}

function drillCapture(): MulticallStep {
  return step({
    url: DRILL_URL,
    responseBody: { stock: [{ id: "r1" }, { id: "n1" }] },
    timestamp: "2024-01-01T00:00:02Z",
  });
}

const FOLD_RETURN_SPEC: FoldReturnSpec = {
  endpointPattern: "inventory/api/v1/stock",
  resultsPath: "data.catalog.results.products.*.variants",
  drillResultsPath: "stock",
  joinFields: ["id"],
};

// The identity emitContractTs would compute for the real search operation —
// see computeEmittedPrimaryAnchor/operationGroupKey in recon-generate.ts.
const EMITTED_PRIMARY_ANCHOR = "/catalog/graph::productSearch";

describe("resolveApplicableFoldPlans — anchor-constrained primary is order-independent", () => {
  it("resolves the SAME primary whether the noise or real candidate is captured first", () => {
    const orderNoiseFirst = [noiseCapture(), realCapture(), drillCapture()];
    const orderRealFirst = [realCapture(), noiseCapture(), drillCapture()];

    const plansNoiseFirst = resolveApplicableFoldPlans(
      orderNoiseFirst,
      FOLD_RETURN_SPEC,
      undefined,
      EMITTED_PRIMARY_ANCHOR
    );
    const plansRealFirst = resolveApplicableFoldPlans(
      orderRealFirst,
      FOLD_RETURN_SPEC,
      undefined,
      EMITTED_PRIMARY_ANCHOR
    );

    expect(plansNoiseFirst).toHaveLength(1);
    expect(plansRealFirst).toHaveLength(1);

    const primaryUrlNoiseFirst = orderNoiseFirst[plansNoiseFirst[0]!.primaryStepIndex]!.capture.url;
    const primaryUrlRealFirst = orderRealFirst[plansRealFirst[0]!.primaryStepIndex]!.capture.url;

    expect(primaryUrlNoiseFirst).toBe(REAL_SEARCH_URL);
    expect(primaryUrlRealFirst).toBe(REAL_SEARCH_URL);
  });
});
