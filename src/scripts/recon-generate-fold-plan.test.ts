import { describe, expect, it } from "vitest";
import { detectDrillDownFoldPlan } from "@/scripts/recon-generate";
import {
  buildMulticallHeterogeneousActionSteps,
  buildMulticallHeterogeneousActionStepsWithDrillDown,
  buildStep,
  type MulticallFixtureStep,
} from "@/scripts/recon-generate-multicall-fixture";

/** `detectDrillDownFoldPlan` takes the unexported `ActionStep[]`; the shared
 * fixture's `MulticallFixtureStep` is structurally identical except for
 * `produces` (`unknown[]` vs. the real `Produce[]`, always empty here — the
 * detector never reads it), so a type-only cast through the detector's own
 * parameter type is safe. */
function detect(steps: MulticallFixtureStep[]): ReturnType<typeof detectDrillDownFoldPlan> {
  return detectDrillDownFoldPlan(steps as unknown as Parameters<typeof detectDrillDownFoldPlan>[0]);
}

describe("detectDrillDownFoldPlan", () => {
  it("detects the available-products (requeried) + available-units drill-down, threaded on productId", () => {
    const plan = detect(buildMulticallHeterogeneousActionStepsWithDrillDown());

    expect(plan).not.toBeNull();
    expect(plan?.primaryArrayPath).toEqual(["products"]);
    expect(plan?.joinFields).toEqual(["productId"]);
    expect(plan?.drillStepIndex).toBe(4);
    expect(plan?.drillArrayPath).toEqual(["units"]);
    // Primary must be one of the requeried available-products/ steps (r2/r3),
    // not the drill-down step itself.
    expect(plan && [2, 3]).toContain(plan?.primaryStepIndex);
  });

  it("returns null for a plain 2-step submission flow with no array-index-threaded request", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/orders/create",
        requestPostData: JSON.stringify({ cartId: "cart-9" }),
        responseBody: { orderId: "order-42" },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/orders/order-42/confirm",
        requestPostData: JSON.stringify({ confirm: true }),
        responseBody: { orderId: "order-42", status: "confirmed" },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];

    expect(detect(steps)).toBeNull();
  });

  it("returns null when the requeried endpoint has no later step that threads a value from its array", () => {
    const plan = detect(buildMulticallHeterogeneousActionSteps());

    expect(plan).toBeNull();
  });
});
