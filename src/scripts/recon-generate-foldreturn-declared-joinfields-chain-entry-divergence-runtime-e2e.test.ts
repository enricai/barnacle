import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A single-hop drill-down whose structural resolution and spec resolution
 * enter the SAME logical drill-down (`r1`) through DIFFERENT chain steps:
 * the structural heuristic threads a nested sub-object field
 * (`priceSummary.currency`) directly into `r1`'s own query string, resolving
 * its target's `drillStepIndex` at `r1`. The declared `foldReturn.joinFields`
 * (`orderId`) never threads into any request — it's only resolvable via an
 * upstream header-token hop (`rtoken`) that
 * `resolveSpecMatchedPrimaryItemIndexAlongChain` walks back to — so
 * `buildFoldPlanFromSpec` resolves its own target's `drillStepIndex` (==
 * `entryIndex`) at `rtoken`, a DIFFERENT raw index than the structural
 * target's, even though both targets' chains terminate at the exact same
 * `r1` call and fold the exact same array. The override must still replace
 * the structural target's inferred `currency` join key with the declared
 * `orderId`, not treat the two as independent drill-downs.
 */
function buildChainEntryDivergenceActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/orders/search/",
      requestPostData: '{"customerId":"c-1"}',
      responseBody: {
        orders: [{ orderId: "ORD1", priceSummary: { currency: "USD" } }],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("rtoken", {
      url: "https://api.example.com/orders/token/",
      requestPostData: null,
      responseBody: { token: "tok-1" },
      requestHeaders: { "Content-Type": "application/json", "X-Order-Id": "ORD1" },
      timestamp: "2024-04-01T00:00:01Z",
      method: "GET",
    }),
    buildStep("r1", {
      url: "https://api.example.com/orders/lookup/?currency=USD",
      requestPostData: null,
      responseBody: {
        order: [{ orderId: "ORD1", currency: "USD", total: 42 }],
      },
      requestHeaders: { "Content-Type": "application/json", "X-Token": "tok-1" },
      timestamp: "2024-04-01T00:00:02Z",
      method: "GET",
    }),
  ];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/orders/lookup/",
  resultsPath: "orders",
  drillResultsPath: "order",
  joinFields: ["orderId"],
};

describe("recon-generate foldReturn declared joinFields — chain-entry divergence between structural and spec resolution", () => {
  it("overrides the structural currency join key with the declared orderId, without emitting a duplicate drill call", () => {
    const actionSteps = buildChainEntryDivergenceActionSteps();
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
      SPEC
    );

    expect(body).toContain('m["orderId"]');
    expect(body).not.toContain('m["currency"]');
    // Exactly one fold target/drill call for this primary — a chain-entry
    // mismatch must not fan the same logical drill-down out into two.
    expect(body.match(/const foldMatches/g)?.length).toBe(1);
    expect(body.match(/\/orders\/lookup\//g)?.length).toBe(1);
  });
});
