import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveFoldPlan } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Reproduces the exact array-depth/consumed-index collision behind the
 * declared-`foldReturn`-ignored report: a primary response holding a
 * SHALLOWER outer array whose single item shares an unrelated boolean field
 * with the drill-down's own request (a false-positive heuristic join key),
 * wrapping a DEEPER nested array whose items carry the real declared join
 * field. The structural heuristic resolves the outer array first (consuming
 * the one drill step both arrays would otherwise thread from), so the
 * nested array's own scan finds nothing left to claim — `resolveFoldPlan`
 * must still land on the spec's declared deeper `resultsPath` and its
 * `joinFields`, not silently keep the heuristic's shallower, decoy-keyed
 * plan.
 */
function buildShallowerHeuristicArrayActionSteps(): MulticallFixtureStep[] {
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
      requestPostData: '{"active":true,"id":"item-1"}',
      responseBody: { details: [{ id: "item-1", price: 9.99 }] },
      timestamp: "2024-05-01T00:00:01Z",
    }),
  ];
}

describe("resolveFoldPlan — declared resultsPath overrides a shallower heuristic-detected array", () => {
  it("resolves the spec's declared deeper primaryArrayPath and joinFields, not the heuristic's shallower decoy-keyed array", () => {
    const steps = buildShallowerHeuristicArrayActionSteps();

    // Without a declaration, the structural heuristic resolves the outer
    // `groups` array on its own decoy `active` field — proving the
    // collision this fixture is meant to exercise actually occurs.
    const heuristicOnly = resolveFoldPlan(steps);
    expect(heuristicOnly).toHaveLength(1);
    expect(heuristicOnly[0]?.primaryArrayPath).toEqual(["groups"]);
    expect(heuristicOnly[0]?.targets[0]?.joinFields).toEqual(["active"]);

    const spec: FoldReturnSpec = {
      endpointPattern: "/catalog/detail/",
      resultsPath: "groups.*.items",
      joinFields: ["id"],
    };

    const plan = resolveFoldPlan(steps, spec);

    expect(plan).toHaveLength(1);
    expect(plan[0]?.primaryArrayPath).toEqual(["groups", "*", "items"]);
    expect(plan[0]?.targets[0]?.joinFields).toEqual(["id"]);
  });
});
