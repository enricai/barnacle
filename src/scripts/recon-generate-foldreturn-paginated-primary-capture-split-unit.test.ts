import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveFoldPlan } from "@/scripts/recon-generate";
import { buildMulticallSingleShotSearchDrillDownNestedJoinFieldPaginatedPrimaryCaptureSplitActionSteps } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Pins the plan-resolution half of the paginated-primary capture split
 * report at the `resolveFoldPlan` level, independent of contract emission:
 * a declared spec naming the primary's freshest capture (`r1`, index 1) and
 * its nested `entries[]` array must resolve to THAT capture, not to the
 * structural heuristic's decoy plan anchored on `r0` (index 0) and keyed on
 * the unrelated boolean `flagged` field.
 */
describe("resolveFoldPlan — paginated primary capture split", () => {
  it("resolves the spec's nested-array plan anchored on the freshest primary capture, not the structural boolean-decoy plan", () => {
    const steps =
      buildMulticallSingleShotSearchDrillDownNestedJoinFieldPaginatedPrimaryCaptureSplitActionSteps();

    const spec: FoldReturnSpec = {
      endpointPattern: "https://api.example.com/catalog/entry-lookup",
      resultsPath: "items.*.entries",
      drillResultsPath: "entries",
      joinFields: ["id"],
    };

    const plan = resolveFoldPlan(steps, spec);

    expect(plan).toHaveLength(1);
    expect(plan[0]?.primaryStepIndex).toBe(1);
    expect(plan[0]?.primaryArrayPath).toEqual(["items", "*", "entries"]);
    expect(plan[0]?.targets[0]?.joinFields).toEqual(["id"]);
  });
});
