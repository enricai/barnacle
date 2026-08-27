import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveFoldPlan } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

const CATALOG_SEARCH_URL = "https://api.example.com/catalog/search";
const ORDER_STATUS_URL = "https://api.example.com/catalog/order-status";
const ORDER_HISTORY_URL = "https://api.example.com/orders/history";

/**
 * The structural plan's ONLY drill call is `r1` (`drillStepIndex: 1`) —
 * `r1`'s own opaque-array response forces `computeFoldChain` to extend the
 * chain to `r2`, so `chain` is `[1, 2]` even though the structural plan never
 * folds FROM `r2` itself. `r2`'s response also carries a second, unrelated
 * array (`contracts`) that a `foldReturn` spec names for a completely
 * different primary (`vendors`, also on `r0`) with its own join field
 * (`vendorId`) — so the spec's own resolved `drillStepIndex` lands on `r2`
 * too, purely because that step's response happens to hold both arrays.
 */
function buildChainTailOverlapActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ orderId: "order-a" }],
        vendors: [{ vendorId: "v1" }],
      },
      timestamp: "2024-11-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: ORDER_STATUS_URL,
      requestPostData: '{"orderId":"order-a"}',
      responseBody: ["status-token-a"],
      timestamp: "2024-11-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: ORDER_HISTORY_URL,
      requestPostData: '{"statusToken":"status-token-a"}',
      responseBody: {
        entries: [{ statusToken: "status-token-a", event: "shipped" }],
        contracts: [{ vendorId: "v1", contractId: "c1" }],
      },
      timestamp: "2024-11-01T00:00:02Z",
    }),
  ];
}

const VENDOR_CONTRACTS_SPEC: FoldReturnSpec = {
  endpointPattern: "/orders/history",
  resultsPath: "vendors",
  drillResultsPath: "contracts",
  joinFields: ["vendorId"],
};

describe("resolveFoldPlan — consumedIndices narrowed to drillStepIndexes", () => {
  it("keeps a spec plan whose own drillStepIndex only collides with a structural chain's TAIL (not its drillStepIndex) as its own independent plan", () => {
    const steps = buildChainTailOverlapActionSteps();

    const plans = resolveFoldPlan(steps, VENDOR_CONTRACTS_SPEC);

    // Without the fix, consumedIndices swept `r1`'s whole chain ([1, 2]),
    // so the spec's own drillStepIndex (2) read as already consumed and
    // specConsumesOnlyItsOwnIndices was false — the spec plan never made it
    // into the returned plans at all.
    const structuralPlan = plans.find(
      (plan) => plan.primaryArrayPath.length === 1 && plan.primaryArrayPath[0] === "results"
    );
    const specPlan = plans.find(
      (plan) => plan.primaryArrayPath.length === 1 && plan.primaryArrayPath[0] === "vendors"
    );

    expect(structuralPlan).toBeDefined();
    expect(structuralPlan?.targets[0]?.chain).toEqual([1, 2]);

    expect(specPlan).toBeDefined();
    expect(specPlan?.targets).toHaveLength(1);
    expect(specPlan?.targets[0]?.drillStepIndex).toBe(2);
    expect(specPlan?.targets[0]?.joinFields).toEqual(["vendorId"]);
  });
});
