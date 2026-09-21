import { describe, expect, it } from "vitest";
import { extractGraphQLActionSequence, type FoldReturnSpec } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Locks in the fix for a read-only flow's real search primary getting
 * dropped when a large population of same-origin, no-query REST POSTs
 * (telemetry/beacon-shaped noise, not GraphQL mutations) used to be treated
 * as "mutations" by HTTP verb alone. That misclassification let the noise
 * populate `mutationPaths` and narrow the flow down to only what shared a
 * structural path token with them — excluding the genuine primary, which
 * shares no token with beacon-style paths. The fix anchors mutation-path
 * narrowing on a genuine GraphQL `mutation` document, so a flow with zero
 * real mutations never narrows at all.
 */

const OWN_HOST = "tracking.example.com";

const searchPrimaryCapture: Capture = {
  timestamp: "2026-01-01T00:00:00.000Z",
  phase: "action",
  method: "POST",
  url: `https://${OWN_HOST}/graphql`,
  status: 200,
  requestHeaders: { "Content-Type": "application/json" },
  requestPostData: '{"op":"TrackShipment"}',
  responseHeaders: {},
  responseBody: {
    data: { shipmentSearch: { results: [{ shipmentId: "1", status: "in-transit" }] } },
  },
  operationName: "TrackShipment",
  query:
    "query TrackShipment($ref: String) {\n  shipmentSearch(ref: $ref) { results { shipmentId status } }\n}",
  variables: { ref: "abc123" },
  decodedParams: null,
};

const drillDownCapture: Capture = {
  timestamp: "2026-01-01T00:00:01.000Z",
  phase: "action",
  method: "GET",
  url: `https://${OWN_HOST}/api/shipment-detail`,
  status: 200,
  requestHeaders: {},
  requestPostData: null,
  responseHeaders: {},
  responseBody: { detail: { shipmentId: "1", carrier: "acme-freight" } },
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
};

const noiseBeaconCapture = (index: number): Capture => ({
  timestamp: `2026-01-01T00:00:${String(2 + index).padStart(2, "0")}.000Z`,
  phase: "action",
  method: "POST",
  url: `https://${OWN_HOST}/telemetry-beacon/user-event`,
  status: 200,
  requestHeaders: { "Content-Type": "application/json" },
  requestPostData: `{"eventId":${index}}`,
  responseHeaders: {},
  responseBody: { ok: true, sequence: index },
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
});

const foldReturnSpec: FoldReturnSpec = {
  endpointPattern: "/api/shipment-detail",
  resultsPath: "data.shipmentSearch.results",
  joinFields: ["shipmentId"],
};

describe("extractGraphQLActionSequence — read-only flow survives REST-noise mutation-path narrowing", () => {
  it("keeps the search primary and its foldReturn drill, and excludes every noise POST", () => {
    const noiseCaptures = Array.from({ length: 6 }, (_, i) => noiseBeaconCapture(i));
    const captures = [searchPrimaryCapture, drillDownCapture, ...noiseCaptures];

    const kept = extractGraphQLActionSequence(captures, null, foldReturnSpec, [OWN_HOST], null);

    expect(kept.map((a) => a.capture.operationName ?? a.capture.url)).toEqual([
      "TrackShipment",
      `https://${OWN_HOST}/api/shipment-detail`,
    ]);
    expect(kept.some((a) => a.capture.url.includes("/telemetry-beacon/"))).toBe(false);
  });
});
