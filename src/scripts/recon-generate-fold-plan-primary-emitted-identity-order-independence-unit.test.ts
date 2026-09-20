import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveFoldPlan } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Locks in bugfix-001 (see recon-generate.ts's `computeEmittedPrimaryAnchor`/
 * `primaryIdentityAnchor`): once `resolveFoldPlan` is constrained to a known
 * emitted-primary identity, its `primaryStepIndex` choice must track that
 * identity, not the candidate's position in the action array. The real
 * primary (`productSearch`) and a decoy (`heartbeat`) below share the exact
 * same `products` array shape and the exact same join value threaded into
 * the drill-down, so before the fix, resolving them with no anchor picks
 * whichever one the array happens to place later (`buildFoldPlanFromSpec`'s
 * "freshest wins" scan) or earlier (`detectDrillDownFoldPlan`'s first-match
 * scan) — an order-dependent choice. With the emitted-primary identity
 * anchored to `productSearch`, the decoy's differing `operationGroupKey`
 * disqualifies it outright in both scans, so the resolved primary must be
 * `productSearch` regardless of which candidate appears first.
 */

const PRODUCT_SEARCH_URL = "https://api.example.com/catalog/product-search";
const HEARTBEAT_URL = "https://api.example.com/telemetry/heartbeat";
const DRILL_URL = "https://api.example.com/inventory/api/v1/items?productId=p1";

// Anchored to productSearch's own operationGroupKey identity
// (`<pathname>::anonymous`, since neither capture carries a GraphQL
// operationName/query) — the same identity `computeEmittedPrimaryAnchor`
// would compute for a REST-emitted primary.
const EMITTED_PRIMARY_ANCHOR = "/catalog/product-search::anonymous";

function realProductSearchStep(): MulticallFixtureStep {
  return buildStep("real", {
    url: PRODUCT_SEARCH_URL,
    requestPostData: JSON.stringify({ page: 1 }),
    responseBody: {
      products: [{ productId: "p1", name: "Widget" }],
    },
    timestamp: "2025-04-01T00:00:00Z",
  });
}

function noiseHeartbeatStep(): MulticallFixtureStep {
  return buildStep("noise", {
    url: HEARTBEAT_URL,
    requestPostData: JSON.stringify({ page: 1 }),
    // Same array field name and same joinable productId value as the real
    // candidate, so a search with no anchor to the emitted primary's
    // identity can resolve this decoy just as readily as the real one.
    responseBody: {
      products: [{ productId: "p1", name: "Ghost" }],
    },
    timestamp: "2025-04-01T00:00:01Z",
  });
}

function drillStep(): MulticallFixtureStep {
  return buildStep("drill", {
    url: DRILL_URL,
    requestPostData: null,
    responseBody: { productId: "p1", stock: 5 },
    timestamp: "2025-04-01T00:00:02Z",
    method: "GET",
  });
}

const FOLD_RETURN_SPEC: FoldReturnSpec = {
  endpointPattern: "/inventory/api/v1/items",
  resultsPath: "products",
  joinFields: ["productId"],
};

describe("resolveFoldPlan — primary resolution anchored to the emitted primary identity", () => {
  it("resolves the real candidate's primaryStepIndex regardless of the noise candidate's array position", () => {
    const realFirst: MulticallFixtureStep[] = [
      realProductSearchStep(),
      noiseHeartbeatStep(),
      drillStep(),
    ];
    const noiseFirst: MulticallFixtureStep[] = [
      noiseHeartbeatStep(),
      realProductSearchStep(),
      drillStep(),
    ];

    const resolvedRealFirst = resolveFoldPlan(realFirst, FOLD_RETURN_SPEC, EMITTED_PRIMARY_ANCHOR);
    const resolvedNoiseFirst = resolveFoldPlan(
      noiseFirst,
      FOLD_RETURN_SPEC,
      EMITTED_PRIMARY_ANCHOR
    );

    expect(resolvedRealFirst).toHaveLength(1);
    expect(resolvedNoiseFirst).toHaveLength(1);

    const realFirstPrimary = realFirst[resolvedRealFirst[0]!.primaryStepIndex]!.capture.url;
    const noiseFirstPrimary = noiseFirst[resolvedNoiseFirst[0]!.primaryStepIndex]!.capture.url;

    expect(realFirstPrimary).toBe(PRODUCT_SEARCH_URL);
    expect(noiseFirstPrimary).toBe(PRODUCT_SEARCH_URL);
  });
});
