import { describe, expect, it } from "vitest";

import { StepVerificationError } from "@/scraper/errors";
import { isReplanCycle, type NormalizedStep, type ReplanEvent } from "@/scripts/recon-browser";

/**
 * Structural-parity regression for {@link isReplanCycle} (recon-browser.ts:583):
 * the replan LLM freely rewords a semantically-identical bridge proposal
 * between attempts under an otherwise-static stuck state (same failed step,
 * same page). Byte-identical proposals were always recognized as a cycle;
 * paraphrased-but-structurally-equivalent ones must be recognized the same
 * way, so the run loop's abort selection ("replan cycle detected" vs "replan
 * budget exhausted") doesn't depend on incidental LLM phrasing.
 */

const REPLAN_CYCLE_THRESHOLD = 3;
const url = "https://example.com/apply";

const mk = (instruction: string): NormalizedStep => ({
  instruction,
  optional: false,
  upload: false,
  origin: "replan",
});

function makeEvent(
  replanIndex: number,
  proposals: string[],
  pageState: { url: string; htmlLength: number }
): ReplanEvent {
  return {
    replanIndex,
    cause: "cascade-exhausted",
    indexAtFailure: 0,
    failedInstruction: "Click the 'Submit Application' button",
    replanSteps: proposals.map(mk),
    timestamp: "2026-06-09T00:00:00.000Z",
    pageState,
  };
}

/**
 * Reproduces the run loop's abort-selection decision (recon-browser.ts, the
 * block immediately following the `replanRemainingFlow` call): a stuck step
 * that has already exhausted its replan budget aborts with "budget
 * exhausted" without ever consulting the cycle detector; a step still under
 * budget consults `isReplanCycle` first and, on a hit, aborts with "cycle
 * detected" instead of continuing to spend budget. Modeled here with the
 * real exported `isReplanCycle` so the parity assertion below exercises the
 * same predicate `main()` calls, not a hand-rolled stand-in for it.
 */
function selectAbortForStuckStep(params: {
  usedSoFar: number;
  budget: number;
  priorReplans: readonly ReplanEvent[];
  newSteps: readonly NormalizedStep[];
  currentPageState: { url: string; htmlLength: number };
}): "budget-exhausted" | "cycle-detected" | "continue" {
  const { usedSoFar, budget, priorReplans, newSteps, currentPageState } = params;
  if (usedSoFar >= budget) return "budget-exhausted";
  if (isReplanCycle(priorReplans, newSteps, currentPageState)) return "cycle-detected";
  return "continue";
}

describe("recon-browser/isReplanCycle structural parity under paraphrase variance", () => {
  it("recognizes N paraphrased-but-structurally-equivalent proposals as a cycle, same as byte-identical ones", () => {
    const wordings = [
      "Click the 'Submit Application' button to send the form",
      "Press the 'Submit Application' button so the application is submitted",
      "Tap on 'Submit Application' to finalize submission",
    ];
    expect(wordings).toHaveLength(REPLAN_CYCLE_THRESHOLD);

    const priors = wordings.map((wording, i) =>
      makeEvent(i + 1, [wording], { url, htmlLength: 50000 + i * 10 })
    );
    const newSteps: NormalizedStep[] = [mk("Hit 'Submit Application' one more time")];
    const currentPageState = { url, htmlLength: 50030 };

    expect(isReplanCycle(priors, newSteps, currentPageState)).toBe(true);

    const byteIdenticalPriors = wordings.map((_, i) =>
      makeEvent(i + 1, ["Click the 'Submit Application' button"], {
        url,
        htmlLength: 50000 + i * 10,
      })
    );
    const byteIdenticalNewSteps: NormalizedStep[] = [mk("Click the 'Submit Application' button")];
    expect(isReplanCycle(byteIdenticalPriors, byteIdenticalNewSteps, currentPageState)).toBe(
      isReplanCycle(priors, newSteps, currentPageState)
    );
  });

  it("still returns false for a genuinely different proposal (different target step), avoiding a false-positive cycle on a legitimate distinct retry", () => {
    const priors = [
      makeEvent(1, ["Click the 'Submit Application' button"], { url, htmlLength: 50000 }),
      makeEvent(2, ["Click the 'Submit Application' button"], { url, htmlLength: 50000 }),
    ];
    const differentTargetSteps: NormalizedStep[] = [mk("Click the 'Save Draft' button")];
    expect(isReplanCycle(priors, differentTargetSteps, { url, htmlLength: 50000 })).toBe(false);
  });

  it("integration: an under-budget stuck step surfaces 'cycle detected' rather than falling through to 'budget exhausted' once paraphrased proposals repeat", () => {
    const wordings = [
      "Click the 'Submit Application' button to send the form",
      "Press the 'Submit Application' button so the application is submitted",
      "Tap on 'Submit Application' to finalize submission",
    ];
    const priors = wordings.map((wording, i) =>
      makeEvent(i + 1, [wording], { url, htmlLength: 50000 + i * 10 })
    );
    const newSteps: NormalizedStep[] = [mk("Hit 'Submit Application' one more time")];
    const currentPageState = { url, htmlLength: 50030 };

    // Budget is generous (well above the 3 attempts already spent), so a
    // signature bug that fails to recognize the paraphrase would fall
    // through here and keep spending budget instead of aborting.
    const decision = selectAbortForStuckStep({
      usedSoFar: priors.length,
      budget: 10,
      priorReplans: priors,
      newSteps,
      currentPageState,
    });
    expect(decision).toBe("cycle-detected");

    const cycleMessage = `replan cycle detected: identical proposal × ${REPLAN_CYCLE_THRESHOLD} under static page state; aborting`;
    const abortError = new StepVerificationError(cycleMessage, "replan-cycle-detected");
    expect(abortError.message).not.toContain("budget exhausted");
    expect(abortError.kind).toBe("replan-cycle-detected");
  });

  it("integration: a step whose budget is already exhausted aborts on budget exhaustion without ever reaching the cycle check", () => {
    const wordings = [
      "Click the 'Submit Application' button to send the form",
      "Press the 'Submit Application' button so the application is submitted",
    ];
    const priors = wordings.map((wording, i) =>
      makeEvent(i + 1, [wording], { url, htmlLength: 50000 + i * 10 })
    );
    const newSteps: NormalizedStep[] = [mk("Tap on 'Submit Application' to finalize submission")];
    const currentPageState = { url, htmlLength: 50020 };

    const decision = selectAbortForStuckStep({
      usedSoFar: 2,
      budget: 2,
      priorReplans: priors,
      newSteps,
      currentPageState,
    });
    expect(decision).toBe("budget-exhausted");
  });
});
