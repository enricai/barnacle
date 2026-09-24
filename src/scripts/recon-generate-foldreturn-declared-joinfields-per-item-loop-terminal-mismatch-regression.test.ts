import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveApplicableFoldPlans } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

const BASE = "https://api.example.com";

/**
 * A single primary with TWO items sharing one per-item drill loop. Item TWO
 * is a "clean" per-item drill-down — its declared `orderId` join field
 * resolves directly off its own terminal drill response, so its structural
 * target and the spec's restricted resolution for it agree on the exact
 * same chain identity, and this occurrence is what the primary's own
 * (unrestricted) freshest-first spec scan lands on. Item ONE is the
 * defect-triggering case: its own per-item chain runs through an upstream
 * header-token hop, then an intermediate decoy hop (also
 * token-authenticated, so chain-dependent) whose response holds a richer
 * object array than the real drill response, before the terminal drill call
 * — which threads a nested sub-object field (`priceSummary.currency`)
 * directly into its own query string. The structural heuristic resolves
 * item one's target starting AT its terminal drill call (the field it
 * threads is only present there), so its forward walk starts and stays at
 * the drill, terminating there. `buildFoldPlanFromSpec`, restricted to that
 * same drill endpoint, instead walks forward from the EARLIER token hop
 * (the only place the declared `orderId` join field resolves for this
 * item), passing through the richer decoy hop first — which wins the
 * forward walk's richness comparison — so the spec's own restricted
 * resolution for item one terminates at the decoy, a DIFFERENT
 * `chainTerminalIndex`/`chainArrayPath` than item one's structural target,
 * even though both describe the exact same logical per-item drill-down.
 * `mergeSpecPlanOntoSamePrimary` must still override item one's structural
 * `currency` join key with the declared `orderId`, not silently keep the
 * structural guess just because its own restricted spec resolution lands
 * on a mismatched chain identity.
 */
function buildPerItemLoopTerminalMismatchActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: `${BASE}/orders/search/`,
      requestPostData: '{"customerId":"c-1"}',
      responseBody: {
        orders: [
          { orderId: "ORD1", priceSummary: { currency: "USD" } },
          { orderId: "ORD2", priceSummary: { currency: "EUR" } },
        ],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("rtoken1", {
      url: `${BASE}/orders/token/widget-01/`,
      requestPostData: null,
      responseBody: { token: "tok-1" },
      requestHeaders: { "Content-Type": "application/json", "X-Order-Id": "ORD1" },
      timestamp: "2024-04-01T00:00:01Z",
      method: "GET",
    }),
    buildStep("rdecoy1", {
      url: `${BASE}/orders/decoy/widget-01/`,
      requestPostData: null,
      responseBody: {
        decoys: [{ decoyA: 1, decoyB: 2, decoyC: 3, decoyD: 4 }],
      },
      requestHeaders: { "Content-Type": "application/json", "X-Token": "tok-1" },
      timestamp: "2024-04-01T00:00:02Z",
      method: "GET",
    }),
    buildStep("r1", {
      url: `${BASE}/orders/lookup/widget-01/?currency=USD`,
      requestPostData: null,
      responseBody: {
        order: [{ orderId: "ORD1", currency: "USD", total: 42 }],
      },
      requestHeaders: { "Content-Type": "application/json", "X-Token": "tok-1" },
      timestamp: "2024-04-01T00:00:03Z",
      method: "GET",
    }),
    buildStep("r2", {
      url: `${BASE}/orders/lookup/widget-02/?currency=EUR`,
      requestPostData: null,
      responseBody: {
        order: [{ orderId: "ORD2", currency: "EUR", total: 99 }],
      },
      timestamp: "2024-04-01T00:00:04Z",
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

describe("resolveApplicableFoldPlans — per-item drill loop honors declared joinFields despite a chain-terminal mismatch on every target", () => {
  it("resolves every per-item target's joinFields to the declared orderId, never the shared currency structural guess", () => {
    const actionSteps = buildPerItemLoopTerminalMismatchActionSteps();

    const plans = resolveApplicableFoldPlans(actionSteps, SPEC, undefined, null);

    expect(plans).toHaveLength(1);
    const [plan] = plans;
    expect(plan!.targets).toHaveLength(2);
    for (const target of plan!.targets) {
      expect(target.joinFields).toEqual(["orderId"]);
    }
  });
});
