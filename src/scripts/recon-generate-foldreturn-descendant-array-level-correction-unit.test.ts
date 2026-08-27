import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveFoldPlan } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Reproduces the level-correction case: the structural heuristic resolves a
 * SHALLOW array via its own unrelated drill call (a different drill step
 * than the spec's), and the flow author separately declares a `foldReturn`
 * whose `resultsPath` names a DEEPER, nested array reached through its own
 * distinct drill call. Because the two drills touch entirely different
 * steps/indices, neither `samePrimaryPlan` (different `primaryArrayPath`)
 * nor `sharedDrillPlan` (no overlapping `drillStepIndex`) catch this, and the
 * spec's own drill indices look fully independent — so the raw-index
 * independence guard would otherwise append the spec plan ALONGSIDE the
 * heuristic's shallower, wrong-level guess instead of replacing it.
 */
function buildDescendantArrayLevelSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: {
        groups: [{ active: true, items: [{ id: "item-1" }, { id: "item-2" }] }],
      },
      timestamp: "2024-05-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/detail/",
      requestPostData: '{"active":true}',
      responseBody: { details: [{ id: "decoy" }] },
      timestamp: "2024-05-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: "https://api.example.com/catalog/detail2/",
      requestPostData: '{"code":"C1"}',
      responseBody: { info: [{ id: "item-1", code: "C1", price: 9.99 }] },
      timestamp: "2024-05-01T00:00:02Z",
    }),
  ];
}

describe("resolveFoldPlan — descendant primaryArrayPath supersedes a shallower structural plan", () => {
  it("replaces the shallower heuristic plan wholesale instead of appending the spec plan alongside it", () => {
    const steps = buildDescendantArrayLevelSteps();

    const heuristicOnly = resolveFoldPlan(steps);
    expect(heuristicOnly).toHaveLength(1);
    expect(heuristicOnly[0]?.primaryArrayPath).toEqual(["groups"]);
    expect(heuristicOnly[0]?.targets[0]?.joinFields).toEqual(["active"]);

    const spec: FoldReturnSpec = {
      endpointPattern: "/catalog/detail2/",
      resultsPath: "groups.*.items",
      joinFields: ["id"],
    };

    const plan = resolveFoldPlan(steps, spec);

    expect(plan).toHaveLength(1);
    expect(plan[0]?.primaryArrayPath).toEqual(["groups", "*", "items"]);
    expect(plan[0]?.targets[0]?.joinFields).toEqual(["id"]);
    expect(plan[0]?.targets.some((target) => target.joinFields.includes("active"))).toBe(false);
  });
});
