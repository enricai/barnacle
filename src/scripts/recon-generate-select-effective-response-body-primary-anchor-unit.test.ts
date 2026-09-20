import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, selectEffectiveResponseBody } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Complements recon-generate-fold-plan-primary-anchor-order-independence-unit.test.ts
 * (which pins `resolveApplicableFoldPlans`'s anchor-constrained resolution —
 * the shape `emitContractTs`'s own runtime fold already anchors to the
 * emitted-primary identity). This pins the fix's remaining half:
 * `selectEffectiveResponseBody` — the call that computes the shape fed into
 * the generated response type/schema — must resolve the SAME primary too,
 * or the generated schema and the generated runtime call can silently
 * describe two different primaries. The noise and real candidates here
 * share the identical structural shape at `foldReturn.resultsPath` but
 * expose a DIFFERING field type (`priceCents` is a number on the real
 * `catalogSearch` primary and a string on the noise `telemetryHeartbeat`
 * capture), so an unanchored call infers a differently-typed shape purely
 * from which candidate is listed first in `actionSteps`.
 */
interface MulticallStep {
  capture: Capture;
  isMultipart: boolean;
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
      phase: "browse",
      method: "POST",
      url: overrides.url,
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: overrides.query
        ? JSON.stringify({ query: overrides.query, variables: {} })
        : null,
      responseHeaders: {},
      responseBody: overrides.responseBody,
      operationName: overrides.operationName ?? null,
      query: overrides.query ?? null,
      variables: {},
      decodedParams: null,
    },
    isMultipart: false,
  };
}

const SEARCH_QUERY = "query catalogSearch { catalog { results { items { id name } } } }";
const NOISE_QUERY =
  "query telemetryHeartbeat { meta { beacons { id } } catalog { results { items { id name } } } }";
const GRAPHQL_URL = "https://api.example.com/graphql";
const DRILL_URL = "https://api.example.com/inventory/api/v1/items";

function realCapture(): MulticallStep {
  return step({
    url: GRAPHQL_URL,
    responseBody: {
      catalog: { results: { items: [{ id: "item-a", name: "Widget", priceCents: 1999 }] } },
    },
    timestamp: "2024-01-01T00:00:00Z",
    operationName: "catalogSearch",
    query: SEARCH_QUERY,
  });
}

// Same resultsPath shape AND the same join id (`item-a`) the drill-down
// capture correlates against, so the structural/spec search cannot tell it
// apart from the real primary on shape alone.
function noiseCapture(): MulticallStep {
  return step({
    url: GRAPHQL_URL,
    responseBody: {
      meta: { beacons: [{ id: "b1" }] },
      catalog: { results: { items: [{ id: "item-a", name: "Beacon", priceCents: "unavailable" }] } },
    },
    timestamp: "2024-01-01T00:00:01Z",
    operationName: "telemetryHeartbeat",
    query: NOISE_QUERY,
  });
}

function drillCapture(): MulticallStep {
  return step({
    url: `${DRILL_URL}?id=item-a`,
    responseBody: { items: [{ id: "item-a", stock: 7 }] },
    timestamp: "2024-01-01T00:00:02Z",
  });
}

const FOLD_RETURN_SPEC: FoldReturnSpec = {
  endpointPattern: "/inventory/api/v1/items",
  resultsPath: "catalog.results.items",
  drillResultsPath: "items",
  joinFields: ["id"],
};

// The identity emitContractTs would compute for the real catalogSearch
// operation — see computeEmittedPrimaryAnchor/operationGroupKey in
// recon-generate.ts.
const EMITTED_PRIMARY_ANCHOR = "/graphql::catalogSearch";

describe("selectEffectiveResponseBody — anchor-constrained shape inference is order-independent", () => {
  it("resolves the SAME primary shape whether the noise or real candidate is captured first, when anchored", () => {
    const orderNoiseFirst = [noiseCapture(), realCapture(), drillCapture()];
    const orderRealFirst = [realCapture(), noiseCapture(), drillCapture()];

    const bodyNoiseFirst = selectEffectiveResponseBody(
      false,
      orderNoiseFirst,
      null,
      FOLD_RETURN_SPEC,
      EMITTED_PRIMARY_ANCHOR
    );
    const bodyRealFirst = selectEffectiveResponseBody(
      false,
      orderRealFirst,
      null,
      FOLD_RETURN_SPEC,
      EMITTED_PRIMARY_ANCHOR
    );

    expect(bodyNoiseFirst).toEqual(bodyRealFirst);
    expect(bodyNoiseFirst).toEqual({
      catalog: { results: { items: [{ id: "item-a", name: "Widget", priceCents: 1999, stock: 7 }] } },
    });
  });

  it("without the anchor, array order picks a different primary's field type (the bug this closes)", () => {
    const orderNoiseFirst = [noiseCapture(), realCapture(), drillCapture()];
    const orderRealFirst = [realCapture(), noiseCapture(), drillCapture()];

    const bodyNoiseFirst = selectEffectiveResponseBody(false, orderNoiseFirst, null, FOLD_RETURN_SPEC);
    const bodyRealFirst = selectEffectiveResponseBody(false, orderRealFirst, null, FOLD_RETURN_SPEC);

    expect(bodyNoiseFirst).not.toEqual(bodyRealFirst);
  });
});
