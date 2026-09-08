import { describe, expect, it } from "vitest";

import { StepVerificationError } from "@/scraper/errors";
import {
  filterCompletedFromReplan,
  filterReplanDuplicatingNextAuthored,
  hasPageAlreadyAdvancedPastStep,
  isReplanRegressingAcrossAuthBoundary,
  isReplanReproposingFailedStep,
  type NormalizedStep,
} from "@/scripts/recon-browser";

/**
 * Offline acceptance regression pinning the reported already-advanced replan
 * spiral: a captcha-gated step's verification fails, but by the time the
 * flow loop would otherwise dispatch a replan, the live page has already
 * navigated past the failed step onto the next section of a multi-step web
 * form.
 *
 * **What this pins:** per `recon-browser.ts`'s flow loop (around line 2691,
 * immediately after the `wizard-regression`/`backend-error-unrecoverable`
 * dispatchers and BEFORE `replanRemainingFlow` is ever invoked),
 * `hasPageAlreadyAdvancedPastStep` is a deterministic pre-replan
 * short-circuit: when it fires, the failed step is pushed onto
 * `completedSteps` and the loop `continue`s WITHOUT calling the replan
 * dispatcher and WITHOUT running any of the splice-time output-filtering
 * pipeline (`filterCompletedFromReplan` -> `isReplanReproposingFailedStep`
 * -> `isReplanRegressingAcrossAuthBoundary` -> `filterReplanDuplicatingNextAuthored`
 * -> `plan.splice`) that `recon-browser.destructive-replan-regression.test.ts`
 * exercises for the *other* replan-triggering branch. There is no
 * synthesized "bridge" step and the original remaining tail is left
 * completely untouched in `plan` — the short-circuit bypasses the pipeline
 * entirely rather than feeding it a placeholder.
 *
 * This test therefore has two parts: (1) it pins the real, exported
 * `hasPageAlreadyAdvancedPastStep` predicate against the report's URLs, and
 * (2) it demonstrates why the bypass exists by showing that if the buggy
 * re-authored raw replan output were instead fed through the real
 * output-filtering pipeline (as it would be if the already-advanced check
 * did NOT short-circuit first), the pipeline offers no protection against
 * the destructive re-authoring — none of the existing guards fire on it, so
 * it would splice the re-authored earlier-form steps directly ahead of the
 * original remaining tail. That is the regression the pre-replan
 * short-circuit exists to prevent.
 */

const mk = (instruction: string, extra: Partial<NormalizedStep> = {}): NormalizedStep => ({
  instruction,
  optional: false,
  upload: false,
  origin: "replan",
  ...extra,
});

/** Steps that already succeeded before the captcha-gated step got stuck. */
const COMPLETED_STEPS = [
  "Fill in the 'Email' field with the applicant's email",
  "Fill in the 'Full Name' field with the applicant's full name",
  "Click the 'Continue' button to advance past the newsletter signup form",
];

const FAILED_STEP = "Solve the captcha challenge to confirm the signup form";

/** The step's URL at the moment the flow loop started it. */
const STEP_START_URL = "https://forms.example.com/signup/step-2";
/** The live URL by the time verification fails — the page already moved on. */
const POST_FAILURE_URL = "https://forms.example.com/signup/step-3";

/** The report's originalRemaining tail — the authored sub-sequence a replan bridge could otherwise strand. */
const ORIGINAL_REMAINING: NormalizedStep[] = [
  "Select 'Weekly' in the 'Digest Frequency' dropdown",
  "Select 'Product Updates' and 'Community Events' in the 'Topics' checkboxes",
  "Click the 'Save Preferences' button",
  "Click the 'Finish' button to complete signup",
].map((instruction) => mk(instruction, { origin: "original" }));

/**
 * The buggy raw replanner output a stale-snapshot replan would produce:
 * re-authors the entire earlier form (email, name, continue, captcha)
 * instead of recognizing the page already advanced past all of it. Never
 * actually reaches `replanRemainingFlow` in the real code, because the
 * already-advanced short-circuit fires first and skips the replan
 * dispatcher entirely — this fixture exists only to demonstrate what the
 * existing filter/guard pipeline would (fail to) do with it if that
 * short-circuit were absent.
 */
const BUGGY_RAW_NEW_STEPS: NormalizedStep[] = [
  "Fill in the 'Email' field with the applicant's email address",
  "Fill in the 'Full Name' field with the applicant's full legal name",
  "Click the 'Continue' button to move past the newsletter signup form",
  "Solve the captcha challenge shown on the signup form",
].map((instruction) => mk(instruction));

/**
 * Reproduces `recon-browser.destructive-replan-regression.test.ts`'s
 * `applyReplanOutputFilters` harness: the real splice-time pipeline
 * `main()` runs on `replanRemainingFlow`'s raw output for the OTHER
 * replan-triggering branches, where the already-advanced short-circuit
 * does not apply.
 */
function applyReplanOutputFilters(params: {
  rawNewSteps: readonly NormalizedStep[];
  completedSteps: readonly string[];
  failedStep: string;
  originalRemaining: readonly NormalizedStep[];
}): NormalizedStep[] {
  const { rawNewSteps, completedSteps, failedStep, originalRemaining } = params;

  const newSteps = filterCompletedFromReplan(rawNewSteps, completedSteps, failedStep);
  if (newSteps.length === 0) {
    throw new StepVerificationError(
      "replan produced only already-completed steps (nothing new to bridge)",
      "replan-cycle-detected"
    );
  }

  if (isReplanReproposingFailedStep(newSteps, failedStep)) {
    throw new StepVerificationError(
      "replan re-proposed only the just-failed step with no new bridge",
      "replan-cycle-detected"
    );
  }

  if (isReplanRegressingAcrossAuthBoundary(newSteps, completedSteps)) {
    throw new StepVerificationError(
      "replan proposed a Sign-In/Log-In step after an account-creation step already completed",
      "replan-cycle-detected"
    );
  }

  const taggedNewSteps = filterReplanDuplicatingNextAuthored(
    newSteps.map((s) => ({ ...s, origin: "replan" as const })),
    originalRemaining
  );
  return [...taggedNewSteps, ...originalRemaining];
}

describe("recon-browser already-advanced replan regression (offline fixture)", () => {
  it("detects the page already advanced past the failed step by the time verification fails", () => {
    expect(hasPageAlreadyAdvancedPastStep(STEP_START_URL, POST_FAILURE_URL)).toBe(true);
  });

  it("does not treat a same-origin-and-path query/hash-only change as advancement (fails closed toward replanning)", () => {
    expect(hasPageAlreadyAdvancedPastStep(STEP_START_URL, `${STEP_START_URL}?modal=open`)).toBe(
      false
    );
    expect(hasPageAlreadyAdvancedPastStep(STEP_START_URL, `${STEP_START_URL}#section`)).toBe(false);
  });

  it("demonstrates the destructive outcome the pre-replan short-circuit exists to prevent: without it, none of the existing splice-time guards catch the re-authored earlier-form bridge", () => {
    // None of the buggy raw steps are already-completed or a re-emission of
    // the failed step, so — absent the already-advanced short-circuit —
    // they would sail through the existing pipeline unfiltered and get
    // spliced directly ahead of the original remaining tail.
    const spliced = applyReplanOutputFilters({
      rawNewSteps: BUGGY_RAW_NEW_STEPS,
      completedSteps: COMPLETED_STEPS,
      failedStep: FAILED_STEP,
      originalRemaining: ORIGINAL_REMAINING,
    });

    expect(spliced).toHaveLength(BUGGY_RAW_NEW_STEPS.length + ORIGINAL_REMAINING.length);
    for (const reauthored of BUGGY_RAW_NEW_STEPS.map((s) => s.instruction)) {
      expect(spliced.map((s) => s.instruction)).toContain(reauthored);
    }
  });

  it("regression guard: hasPageAlreadyAdvancedPastStep returns false when the page has not moved, so the flow loop's existing replan path remains reachable", () => {
    expect(hasPageAlreadyAdvancedPastStep(STEP_START_URL, STEP_START_URL)).toBe(false);
  });
});
