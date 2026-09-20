import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, selectEffectiveResponseBody } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Pins `selectEffectiveResponseBody`'s own `resolveFoldPlan` call (see its
 * docstring in recon-generate.ts) to the same emitted-primary anchor
 * `resolveApplicableFoldPlans` already resolves against. The real primary
 * (`productSearch`) and a decoy (`heartbeat`) below share the same `products`
 * array shape but fold in DIFFERENT per-item fields (`price` vs `extra`), so
 * an unanchored search that happens to resolve the decoy instead of the real
 * primary produces a visibly different folded body depending on which
 * candidate appears first in the action array.
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
    // Distinct field names per candidate so the two orderings' folded
    // bodies are trivially distinguishable if the wrong primary is picked.
    responseBody: { productId: "p1", price: 9.99, extra: "decoy-field" },
    timestamp: "2025-04-01T00:00:02Z",
    method: "GET",
  });
}

const FOLD_RETURN_SPEC: FoldReturnSpec = {
  endpointPattern: "/inventory/api/v1/items",
  resultsPath: "products",
  joinFields: ["productId"],
};

describe("selectEffectiveResponseBody — shape inference anchored to the emitted primary identity", () => {
  it("resolves the same folded body regardless of the noise candidate's array position", () => {
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

    const bodyA = selectEffectiveResponseBody(
      false,
      realFirst,
      realFirst[0]!.capture.responseBody,
      FOLD_RETURN_SPEC,
      EMITTED_PRIMARY_ANCHOR
    );
    const bodyB = selectEffectiveResponseBody(
      false,
      noiseFirst,
      noiseFirst[1]!.capture.responseBody,
      FOLD_RETURN_SPEC,
      EMITTED_PRIMARY_ANCHOR
    );

    expect(bodyA).toEqual(bodyB);
  });
});
