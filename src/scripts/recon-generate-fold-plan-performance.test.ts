import { describe, expect, it } from "vitest";
import { type FoldPlan, resolveFoldPlan } from "@/scripts/recon-generate";
import {
  buildFoldReturnScalableActionSequence,
  FOLD_RETURN_SCALABLE_SPEC,
} from "@/scripts/recon-generate-multicall-fixture";

// Reproduces the incident's 2146-capture, >11-minute hang
// (docs/recon-generate-foldreturn-hangs-fold-plan-computation-on-large-capture-set.md
// lines 5-9, 25-27): a foldReturn declared over a large capture set where the
// structural heuristic finds nothing, forcing buildFoldPlanFromSpec's
// primary/drill scan to walk the full set. 5000ms gives ample headroom above
// the incident's own reported ~1.9s no-foldReturn baseline at this scale
// while remaining far below the reported multi-minute hang, so this fails
// loudly if the fold-plan computation regresses back to superlinear.
describe("resolveFoldPlan at scale", () => {
  it("resolves the single real fold plan for a 2500-capture set within a strict wall-clock bound", () => {
    const steps = buildFoldReturnScalableActionSequence(2500);

    const start = performance.now();
    const plans = resolveFoldPlan(steps, FOLD_RETURN_SCALABLE_SPEC) as FoldPlan[];
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(5000);

    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan?.primaryStepIndex).toBe(0);
    expect(plan?.targets).toHaveLength(1);
    expect(plan?.targets[0]?.drillStepIndex).toBe(2499);
    expect(plan?.targets[0]?.joinFields).toEqual(["sku"]);
  });
});
