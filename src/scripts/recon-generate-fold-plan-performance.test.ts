import { describe, expect, it } from "vitest";
import { type FoldPlan, resolveFoldPlan } from "@/scripts/recon-generate";
import {
  buildFoldReturnScalableActionSequence,
  buildFoldReturnWildcardScalableActionSequence,
  FOLD_RETURN_SCALABLE_SPEC,
  FOLD_RETURN_WILDCARD_SCALABLE_SPEC,
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

  // Machine-speed-independent complement to the fixed-ms bound above: a 4x
  // growth in capture count should produce roughly a 4x growth in elapsed
  // time if resolveFoldPlan is linear. A quadratic-or-worse regression would
  // produce a ~16x+ growth, so a 10x ratio bound catches the regression on
  // both fast and slow CI hardware without relying on an absolute threshold.
  it("scales roughly linearly, not quadratically, as the capture count grows", () => {
    const smallSteps = buildFoldReturnScalableActionSequence(500);
    const smallStart = performance.now();
    resolveFoldPlan(smallSteps, FOLD_RETURN_SCALABLE_SPEC);
    const smallElapsedMs = performance.now() - smallStart;

    const largeSteps = buildFoldReturnScalableActionSequence(2000);
    const largeStart = performance.now();
    resolveFoldPlan(largeSteps, FOLD_RETURN_SCALABLE_SPEC);
    const largeElapsedMs = performance.now() - largeStart;

    const ratio = largeElapsedMs / Math.max(smallElapsedMs, 1);

    expect(ratio).toBeLessThan(10);
  });
});

// Wildcard-resultsPath counterpart to the above: the incident doc reports the
// hang reproduced under both a wildcard resultsPath ('data.cruiseSearch.
// results.cruises.*.sailings') and a flat one as separately-isolated
// configurations, but the fix's linear scaling was only proven above for a
// flat resultsPath. objectItemsAtPath's ARRAY_WILDCARD_SEGMENT flatMap branch
// (recon-generate.ts:6156) is exercised here instead, at the same 2500-action
// scale, to confirm the value-indexed pruning generalizes to it.
describe("resolveFoldPlan at scale with a wildcard resultsPath", () => {
  it("resolves the single real fold plan for a 2500-capture wildcard-nested set within a strict wall-clock bound", () => {
    const steps = buildFoldReturnWildcardScalableActionSequence(2500);

    const start = performance.now();
    const plans = resolveFoldPlan(steps, FOLD_RETURN_WILDCARD_SCALABLE_SPEC) as FoldPlan[];
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
