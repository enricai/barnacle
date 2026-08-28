import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveFoldPlan } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Reproduces the descendant-array-level collision with a structural plan
 * that has MULTIPLE drill targets, none of whose own `drillStepIndex`
 * equals the spec's declared drill step, but whose replay CHAIN (one
 * target's dependent follow-up call) does reach that step. Before the
 * merge-independence guard was narrowed to `drillStepIndex` (rather than
 * sweeping every chain index), this collision made the spec's own drill
 * step look already "consumed" even though only the raw-index guard was
 * ever meant to see it — and the descendant-array-level supersession must
 * still replace the shallower structural plan wholesale regardless.
 */
function buildDescendantArrayLevelNoDrillOverlapActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/directory/search/",
      requestPostData: '{"page":1}',
      responseBody: {
        groups: [
          {
            active: true,
            items: [{ id: "entry-1" }, { id: "entry-2" }],
          },
        ],
      },
      timestamp: "2024-05-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/directory/detail/",
      requestPostData: '{"active":true,"variant":"a"}',
      responseBody: { details: [{ code: "d1", token: "tok-entry-1" }] },
      timestamp: "2024-05-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: "https://api.example.com/directory/detail/",
      requestPostData: '{"active":true,"variant":"b"}',
      responseBody: { details: [{ code: "d2", token: "tok-entry-2" }] },
      timestamp: "2024-05-01T00:00:02Z",
    }),
    buildStep("r3", {
      url: "https://api.example.com/directory/confirm/",
      requestPostData: '{"token":"tok-entry-1"}',
      responseBody: { confirmed: true, id: "entry-1" },
      timestamp: "2024-05-01T00:00:03Z",
    }),
  ];
}

describe("resolveFoldPlan — descendant spec array survives a no-drill-overlap chain collision", () => {
  it("honors the spec's deeper declared array level instead of the shallower boolean-keyed structural plan", () => {
    const steps = buildDescendantArrayLevelNoDrillOverlapActionSteps();

    // Without a declaration, the structural heuristic resolves the outer
    // `groups` array on its own decoy `active` field, with one drill
    // target's chain extending into the later `confirm` step — proving
    // both the collision and the shallow decoy-keyed plan are real.
    const heuristicOnly = resolveFoldPlan(steps);
    expect(heuristicOnly).toHaveLength(1);
    expect(heuristicOnly[0]?.primaryArrayPath).toEqual(["groups"]);
    expect(heuristicOnly[0]?.targets.every((target) => target.joinFields.includes("active"))).toBe(
      true
    );
    const entry1Target = heuristicOnly[0]?.targets.find((target) => target.drillStepIndex === 1);
    expect(entry1Target?.chain).toContain(3);
    expect(heuristicOnly[0]?.targets.map((target) => target.drillStepIndex).sort()).toEqual([1, 2]);

    const spec: FoldReturnSpec = {
      endpointPattern: "/directory/confirm/",
      resultsPath: "groups.*.items",
      joinFields: ["id"],
    };

    const plan = resolveFoldPlan(steps, spec);

    expect(plan).toHaveLength(1);
    expect(plan[0]?.primaryArrayPath).toEqual(["groups", "*", "items"]);
    expect(plan[0]?.targets[0]?.joinFields).toEqual(["id"]);
    // The spec's own drillStepIndex (3) is distinct from every structural
    // target's drillStepIndex (1, 2) — the collision is purely a chain
    // overlap, not a shared drill step — so the supersession above is
    // proven to have come from isDescendantArrayPath, not sharedDrillPlan.
    expect(plan[0]?.targets[0]?.drillStepIndex).toBe(3);
  });
});
