import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveFoldPlan } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Reproduces the reported chain-tail collision: the structural heuristic
 * resolves a shallow decoy `groups` array (`r0`) with TWO independent
 * boolean-keyed drill targets (`r1`/`r2`, distinct from the spec's own
 * drill), and each target's forward-walked `chain` threads through the
 * spec's own drill step (`r3`) on its way to a richer downstream response —
 * mirroring the reported chains `[1,3,4,5]`/`[2,3,4,5]` both catching the
 * spec's drill index. The spec's own primary array (`r0b`) resolves on a
 * DIFFERENT endpoint than the decoy `groups` step, so this exercises the
 * `specConsumesOnlyItsOwnIndices` independence guard (whose whole-chain
 * sweep the fix narrowed to `drillStepIndex`), not the unconditional
 * same-endpoint `supersededShallowerPlan` wholesale-replace branch a
 * same-endpoint descendant would trigger regardless of chain overlap.
 */
function buildChainTailCollisionAcrossIndependentPrimariesActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/toggle-source/",
      requestPostData: '{"page":1}',
      responseBody: { groups: [{ activeA: true, activeB: false }] },
      timestamp: "2024-06-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/toggle-a/",
      requestPostData: '{"activeA":true}',
      responseBody: { activeA: true, tokenA: "tok-a" },
      timestamp: "2024-06-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: "https://api.example.com/catalog/toggle-b/",
      requestPostData: '{"activeB":false}',
      responseBody: { activeB: false, tokenB: "tok-b" },
      timestamp: "2024-06-01T00:00:02Z",
    }),
    buildStep("r0b", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: {
        groups: [{ items: [{ id: "item-1" }, { id: "item-2" }] }],
      },
      timestamp: "2024-06-01T00:00:03Z",
    }),
    buildStep("r3", {
      url: "https://api.example.com/catalog/detail/",
      requestPostData: '{"id":"item-1","tokenA":"tok-a","tokenB":"tok-b"}',
      responseBody: { details: [{ id: "item-1", price: 9.99 }] },
      timestamp: "2024-06-01T00:00:04Z",
    }),
  ];
}

describe("resolveFoldPlan — spec's independent deeper array is not discarded when structural chains merely reach its drill step", () => {
  it("keeps the spec's own deeper plan alongside the unrelated shallow structural plan", () => {
    const steps = buildChainTailCollisionAcrossIndependentPrimariesActionSteps();

    // Without a declaration, the structural heuristic resolves only the
    // shallow decoy `groups` array with two independent boolean-keyed
    // targets whose chains both reach forward into the spec's own drill
    // step (r3, index 4) — proving the collision this fixture is meant to
    // exercise actually occurs, exactly as reported.
    const heuristicOnly = resolveFoldPlan(steps);
    expect(heuristicOnly).toHaveLength(1);
    expect(heuristicOnly[0]?.primaryArrayPath).toEqual(["groups"]);
    expect(heuristicOnly[0]?.targets).toHaveLength(2);
    expect(heuristicOnly[0]?.targets[0]?.joinFields).toEqual(["activeA"]);
    expect(heuristicOnly[0]?.targets[0]?.chain).toContain(4);
    expect(heuristicOnly[0]?.targets[1]?.joinFields).toEqual(["activeB"]);
    expect(heuristicOnly[0]?.targets[1]?.chain).toContain(4);

    const spec: FoldReturnSpec = {
      endpointPattern: "/catalog/detail/",
      resultsPath: "groups.*.items",
      joinFields: ["id"],
    };

    const plans = resolveFoldPlan(steps, spec);

    // Before the fix, consumedIndices swept each structural target's WHOLE
    // chain (including the tail at index 4), so the spec's own
    // drillStepIndex (also 4) read as already consumed and
    // specConsumesOnlyItsOwnIndices was false — the spec's plan never made
    // it into the returned plans at all, silently discarded.
    const specPlan = plans.find(
      (plan) => JSON.stringify(plan.primaryArrayPath) === JSON.stringify(["groups", "*", "items"])
    );
    expect(specPlan).toBeDefined();
    expect(specPlan?.targets).toHaveLength(1);
    expect(specPlan?.targets[0]?.drillStepIndex).toBe(4);
    expect(specPlan?.targets[0]?.joinFields).toEqual(["id"]);

    // The unrelated shallow structural plan is untouched — the spec's own
    // independent target is appended, not merged onto or replacing it.
    const structuralPlan = plans.find(
      (plan) => JSON.stringify(plan.primaryArrayPath) === JSON.stringify(["groups"])
    );
    expect(structuralPlan).toBeDefined();
    expect(structuralPlan?.targets).toHaveLength(2);
  });
});
