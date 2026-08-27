import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveFoldPlan } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Reproduces the descendant-`primaryArrayPath` discard: the structural
 * heuristic resolves the SHALLOW `groups` array with TWO independent
 * decoy-boolean-keyed drill targets (`r1`/`r2`, distinct from the spec's own
 * drill), and each target's forward-walked `chain` threads through the
 * spec's drill step (`r3`) on its way to a richer downstream response —
 * mirroring the reported chains `[1,3,4,5]`/`[2,3,4,5]` both catching drill
 * index 3. The spec declares the DEEPER `groups.*.items` array — a strict
 * descendant of the structural guess, not a second independent array — with
 * its own `joinFields` and a drill at that same shared index. `resolveFoldPlan`
 * must still land on the spec's declared deeper level, not silently keep the
 * shallower, decoy-keyed structural plan.
 */
function buildDescendantArrayLevelCollisionActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: {
        groups: [
          {
            activeA: true,
            activeB: false,
            items: [{ id: "item-1" }, { id: "item-2" }],
          },
        ],
      },
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
    buildStep("r3", {
      url: "https://api.example.com/catalog/detail/",
      requestPostData: '{"id":"item-1","tokenA":"tok-a","tokenB":"tok-b"}',
      responseBody: { details: [{ id: "item-1", price: 9.99 }] },
      timestamp: "2024-06-01T00:00:03Z",
    }),
  ];
}

describe("resolveFoldPlan — declared resultsPath is a descendant of a shallower structural array whose chains reach the spec's drill", () => {
  it("resolves the spec's declared deeper primaryArrayPath and joinFields, not the shallower structural plan's decoy joinFields", () => {
    const steps = buildDescendantArrayLevelCollisionActionSteps();

    // Without a declaration, the structural heuristic resolves the outer
    // `groups` array with two independent decoy-boolean-keyed targets whose
    // chains both reach forward into the spec's own drill step (r3) —
    // proving the collision this fixture is meant to exercise actually
    // occurs, exactly as reported.
    const heuristicOnly = resolveFoldPlan(steps);
    expect(heuristicOnly).toHaveLength(1);
    expect(heuristicOnly[0]?.primaryArrayPath).toEqual(["groups"]);
    expect(heuristicOnly[0]?.targets).toHaveLength(2);
    expect(heuristicOnly[0]?.targets[0]?.joinFields).toEqual(["activeA"]);
    expect(heuristicOnly[0]?.targets[0]?.chain).toContain(3);
    expect(heuristicOnly[0]?.targets[1]?.joinFields).toEqual(["activeB"]);
    expect(heuristicOnly[0]?.targets[1]?.chain).toContain(3);

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
