import { describe, expect, it } from "vitest";

import { StepVerificationError } from "@/scraper/errors";
import { isReplanCycle, type NormalizedStep, type ReplanEvent } from "@/scripts/recon-browser";

/**
 * Acceptance test pinning the replan/cascade-exhaustion abort signature
 * (recon-browser.ts:583 {@link isReplanCycle}) for an identically-shaped
 * stuck-step condition: two runs hitting the same failed step, the same
 * phantom-click pattern, and the same static page state must always exit
 * via the same terminal-abort signature -- either "replan cycle detected"
 * or "replan budget exhausted" -- never split nondeterministically between
 * the two depending on incidental LLM paraphrase wording (report Signature
 * C: v54ah aborted via "replan cycle detected" at replan 7/8 while v54s/
 * v54w ran the full budget to "phantom-click-exhausted ... exhausted
 * (8/8)" for the same stuck shape).
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

describe("flow-runner/isReplanCycle deterministic abort signature for identically-shaped stuck steps", () => {
  it("two paraphrased-but-structurally-equivalent replan proposals under identical static page state are both recognized as the same cycle", () => {
    const wordings = [
      "Click the 'Submit Application' button to send the form",
      "Press the 'Submit Application' button so the application is submitted",
      "Tap on 'Submit Application' to finalize submission",
    ];
    expect(wordings).toHaveLength(REPLAN_CYCLE_THRESHOLD);

    const priorsA = wordings.map((wording, i) =>
      makeEvent(i + 1, [wording], { url, htmlLength: 50000 + i * 10 })
    );
    const newStepsA: NormalizedStep[] = [mk("Hit 'Submit Application' one more time")];
    const currentPageState = { url, htmlLength: 50030 };

    const priorsB = wordings.map((_, i) =>
      makeEvent(i + 1, ["Click the 'Submit Application' button"], {
        url,
        htmlLength: 50000 + i * 10,
      })
    );
    const newStepsB: NormalizedStep[] = [mk("Click the 'Submit Application' button")];

    expect(isReplanCycle(priorsA, newStepsA, currentPageState)).toBe(true);
    expect(isReplanCycle(priorsB, newStepsB, currentPageState)).toBe(
      isReplanCycle(priorsA, newStepsA, currentPageState)
    );
  });

  it("an integration-shaped run reproducing the abort-selection decision surfaces 'replan cycle detected' rather than falling through to 'replan budget exhausted' for a stuck shape still under budget", () => {
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

  it("a structurally identical stuck-step condition whose budget is already exhausted deterministically aborts on budget exhaustion, never on cycle detection", () => {
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
