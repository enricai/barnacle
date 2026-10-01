import { describe, expect, it } from "vitest";
import {
  type FoldReturnSpec,
  resolveApplicableFoldPlans,
  resolveFoldPlan,
} from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

const BASE = "https://api.fleet-rental-fixture.example.org";

/**
 * Mirrors the production-scale e2e fixture's listing capture (see
 * recon-generate-large-noisy-rest-archive-nested-fold-submit-classification-compile-cascade-e2e.test.ts):
 * a declared `foldReturn` whose `endpointPattern` matches the SAME capture
 * that holds `resultsPath` — a self-fold, not a separate later drill-down
 * call — with `resultsPath` nesting the per-item array TWO wildcard levels
 * deep inside that one capture's own response body.
 */
function buildSingleCaptureNestedTwoLevelWildcardSteps(): MulticallFixtureStep[] {
  const listing = buildStep("r0", {
    url: `${BASE}/api/fleet/fleet-availability?market=west`,
    requestPostData: null,
    responseBody: {
      locations: [
        {
          locationId: "location-0",
          categories: [
            {
              categoryId: "category-0-0",
              vehicles: [
                { vehicleId: "vehicle-0-0-0", dailyRate: 40 },
                { vehicleId: "vehicle-0-0-1", dailyRate: 41 },
              ],
            },
          ],
        },
        {
          locationId: "location-1",
          categories: [
            {
              categoryId: "category-1-0",
              vehicles: [{ vehicleId: "vehicle-1-0-0", dailyRate: 40 }],
            },
          ],
        },
      ],
    },
    timestamp: "2026-01-01T00:00:00Z",
    method: "GET",
  });

  return [listing];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "fleet-availability",
  resultsPath: "locations.*.categories.*.vehicles",
  joinFields: ["vehicleId"],
};

describe("buildFoldPlanFromSpec / resolveFoldPlan — single-capture two-level-wildcard self-fold", () => {
  it("resolves a fold plan against the declared resultsPath's own nested array, keyed on the declared joinFields", () => {
    const actionSteps = buildSingleCaptureNestedTwoLevelWildcardSteps();

    const plans = resolveFoldPlan(actionSteps, SPEC);

    expect(plans).toHaveLength(1);
    const [plan] = plans;
    expect(plan!.primaryArrayPath).toEqual(["locations", "*", "categories", "*", "vehicles"]);
    expect(plan!.targets).toHaveLength(1);
    const [target] = plan!.targets;
    expect(target!.joinFields).toEqual(["vehicleId"]);
    // The matched drill IS the primary capture itself — no separate
    // drill-down call exists for this spec.
    expect(target!.drillStepIndex).toBe(0);
    expect(target!.chainTerminalIndex).toBe(0);
    expect(target!.chainArrayPath).toEqual(["locations", "*", "categories", "*", "vehicles"]);
  });

  it("resolveApplicableFoldPlans surfaces the same declared joinFields, not a structurally-guessed alternative", () => {
    const actionSteps = buildSingleCaptureNestedTwoLevelWildcardSteps();

    const plans = resolveApplicableFoldPlans(actionSteps, SPEC, undefined, null);

    expect(plans).toHaveLength(1);
    const [plan] = plans;
    expect(plan!.targets).toHaveLength(1);
    expect(plan!.targets[0]!.joinFields).toEqual(["vehicleId"]);
  });
});
