import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Locks in the fix applied in commit c0c149b (buildFoldPlanFromSpec's
 * exactPrimaryStepIndex + mergeSpecPlanOntoSamePrimary resolving the
 * declared joinFields override independently per re-issued primary
 * occurrence) for the exact reported shape: a primary "orders" search
 * endpoint re-issued twice, each driving its own per-item drill call to the
 * SAME shipment-detail endpoint, where the declared joinFields value
 * (`shipmentId`) appears ONLY in response bodies (the search response's
 * item AND the drill response's row) — the drill request URL is built off
 * a DIFFERENT primary field (`orderCode`), so `shipmentId`'s value never
 * appears in any request on either occurrence, matching the reported
 * "joinFields value never appears in any request, only in response schema
 * shape" condition exactly.
 */
function buildReissuedOrdersActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/orders/search/",
      requestPostData: '{"q":"open"}',
      responseBody: {
        orders: [
          {
            orderCode: "ord-1",
            shipmentId: "shp-1",
            region: "us",
            total: { currency: "USD", taxIncluded: true },
          },
        ],
      },
      timestamp: "2024-05-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/orders/shipments/?orderCode=ord-1",
      requestPostData: null,
      responseBody: {
        shipments: [
          { shipmentId: "shp-1", total: { currency: "USD", taxIncluded: true }, status: "packed" },
        ],
      },
      timestamp: "2024-05-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: "https://api.example.com/orders/search/",
      requestPostData: '{"q":"open"}',
      responseBody: {
        orders: [
          {
            orderCode: "ord-2",
            shipmentId: "shp-2",
            region: "eu",
            total: { currency: "EUR", taxIncluded: false },
          },
        ],
      },
      timestamp: "2024-05-01T00:00:02Z",
    }),
    buildStep("r3", {
      url: "https://api.example.com/orders/shipments/?orderCode=ord-2",
      requestPostData: null,
      responseBody: {
        shipments: [
          { shipmentId: "shp-2", total: { currency: "EUR", taxIncluded: false }, status: "packed" },
        ],
      },
      timestamp: "2024-05-01T00:00:03Z",
    }),
  ];
}

const RESPONSE_ONLY_REISSUED_SPEC: FoldReturnSpec = {
  endpointPattern: "/orders/shipments/",
  resultsPath: "orders",
  drillResultsPath: "shipments",
  joinFields: ["shipmentId"],
};

describe("recon-generate foldReturn declared joinFields — response-only field on a re-issued per-item drill endpoint", () => {
  it("emits the declared shipmentId join key for every occurrence of the re-issued primary, never a structural guess", () => {
    const actionSteps = buildReissuedOrdersActionSteps();
    const inputBody = JSON.parse(actionSteps[0]!.capture.requestPostData ?? "null") as unknown;

    const body = emitMultiStepExecuteHttp(
      actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      inputBody,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      new Map(),
      new Map(),
      RESPONSE_ONLY_REISSUED_SPEC
    );

    // The declared `shipmentId` join must key BOTH re-issued occurrences'
    // fold matches, not just the freshest one.
    expect(body.match(/m\["shipmentId"\]/g)?.length).toBe(2);
    // The structural heuristic's own guessed fields must never survive as
    // the emitted match key on either occurrence.
    expect(body).not.toContain('m["orderCode"]');
    expect(body).not.toContain('total"] as Record<string, unknown>)?.["currency"]');
    expect(body).not.toContain('total"] as Record<string, unknown>)?.["taxIncluded"]');
  });
});
