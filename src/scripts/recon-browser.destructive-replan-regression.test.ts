import { describe, expect, it } from "vitest";

import { StepVerificationError } from "@/scraper/errors";
import {
  filterCompletedFromReplan,
  filterReplanDuplicatingNextAuthored,
  isReplanRegressingAcrossAuthBoundary,
  isReplanReproposingFailedStep,
  type NormalizedStep,
} from "@/scripts/recon-browser";

/**
 * Offline acceptance regression pinning the destructive-replan collapse
 * (evidence: destructive-replan.json, replanIndex 2 — a "Fill in the 'City'
 * field" step stuck-failed after account creation): the LLM replanner's raw
 * bridge re-routed through a Sign-In/Log-In flow (two Sign-In proposals up
 * front), and — because the bridge lands on a page shape the original
 * flow's re-appended remaining tail was never authored against — silently
 * stranded the application, with the recorded replan event showing the
 * flow's remaining work collapsed from 19 authored steps down to the
 * 7-step Sign-In bridge (dropping Work History/resume, Application
 * Questions, Voluntary Demographics, Disability Status, Review, and Submit from
 * ever being reached against a compatible page).
 *
 * **What this pins:** the full splice-time output-filtering path
 * `main()` runs on `replanRemainingFlow`'s raw output —
 * `filterCompletedFromReplan` -> `isReplanReproposingFailedStep` ->
 * `isReplanRegressingAcrossAuthBoundary` (bugfix, `recon-browser.ts`) ->
 * `filterReplanDuplicatingNextAuthored` -> splice — proving the
 * auth-boundary guard vetoes this exact reported bridge BEFORE the splice
 * that would otherwise silently strand the tail, so the run aborts instead
 * of resuming through an incompatible Sign-In page. Distinct from
 * `recon-browser.test.ts`'s isolated `isReplanRegressingAcrossAuthBoundary`
 * unit coverage (bugfix-level, single predicate) — this exercises the same
 * composed pipeline `main()`'s replan branch runs, against the report's
 * literal step text, end to end.
 */

const mk = (instruction: string, extra: Partial<NormalizedStep> = {}): NormalizedStep => ({
  instruction,
  optional: false,
  upload: false,
  origin: "replan",
  ...extra,
});

/** Steps that already succeeded before the City field got stuck — includes the account-creation step the auth-boundary guard keys off of. */
const COMPLETED_STEPS = [
  "Fill in the 'Email' field with the applicant's email",
  "Fill in the 'Password' field with a generated password",
  "Click the 'Create Account' button",
  "Fill in the 'First Name' field with the applicant's first name",
  "Fill in the 'Last Name' field with the applicant's last name",
  "Fill in the 'Address Line 1' field with the applicant's street address",
];

const FAILED_STEP = "Fill in the 'City' field with the applicant's city";

/** The report's literal 19-step originalRemaining tail — the authored sub-sequence the guard exists to protect. */
const ORIGINAL_REMAINING: NormalizedStep[] = [
  "Select 'California' in the 'State' dropdown",
  "Fill in the 'Postal Code' field with '94105'",
  "Select 'United States of America' in the 'Country' dropdown",
  "Fill in the 'Phone' field with the applicant's phone number",
  "Click the 'Save and Continue' button to advance to Work History",
  "Upload the applicant's resume file in the 'Resume/CV' upload field",
  "Click the 'Add' button to add a Work Experience entry",
  "Fill in the 'Job Title' field with the applicant's most recent job title",
  "Fill in the 'Company' field with the applicant's most recent employer",
  "Fill in the 'Start Date' field with the applicant's employment start date",
  "Click the 'I currently work here' checkbox",
  "Click the 'Save' button to save the Work Experience entry",
  "Click the 'Next' button to advance to Screening Questions",
  "Select 'Yes' in response to the Screening Questions eligibility question",
  "Click the 'Next' button to advance to Voluntary Demographics",
  "Select 'I do not wish to answer' for each Voluntary Demographics question",
  "Click the 'Next' button to advance to Disability Status",
  "Select 'Decline to self-identify' in the Disability Status dropdown",
  "Click the 'Review' button, then click the final 'Submit' button",
].map((instruction) => mk(instruction, { origin: "original" }));

/** The report's literal buggy 7-step raw replanner output: two Sign-In proposals, then a bridge that never reaches resume/experience/EEO/submit. */
const BUGGY_RAW_NEW_STEPS: NormalizedStep[] = [
  "Click the 'Sign In' button",
  "Click 'Sign In' on the returning-applicant modal",
  "Fill in the 'Email' field with the applicant's email address",
  "Fill in the 'Password' field with the applicant's account password",
  "Click the 'Continue' button after signing in",
  "Select 'United States of America' in the 'Country' dropdown",
  "Click the 'Save and Continue' button",
].map((instruction) => mk(instruction));

/**
 * Reproduces the exact splice-time pipeline `main()` runs on
 * `replanRemainingFlow`'s raw output (`recon-browser.ts`, the block
 * immediately following the `replanRemainingFlow` call), using the real
 * exported filter/guard functions. Throws the same `StepVerificationError`
 * `main()` throws when a guard vetoes the bridge — the run aborts before
 * ever calling `plan.splice`.
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

describe("recon-browser destructive-replan regression (19->7 Sign-In-bridge collapse, offline fixture)", () => {
  it("detects the reported bridge as a Sign-In regression across the account-creation boundary", () => {
    // Pin the report's literal fixture shape (replanIndex 2: 19-step
    // originalRemaining, 7-step buggy newRemaining) before exercising it.
    expect(ORIGINAL_REMAINING).toHaveLength(19);
    expect(BUGGY_RAW_NEW_STEPS).toHaveLength(7);

    // Sanity: none of these 7 steps are already-completed or a re-emission of
    // the failed step, so they reach the auth-boundary guard unfiltered — the
    // guard's own detection is the thing under test, not an upstream filter
    // incidentally removing the Sign-In steps first.
    const survivingCompletedFilter = filterCompletedFromReplan(
      BUGGY_RAW_NEW_STEPS,
      COMPLETED_STEPS,
      FAILED_STEP
    );
    expect(survivingCompletedFilter).toHaveLength(7);
    expect(isReplanReproposingFailedStep(survivingCompletedFilter, FAILED_STEP)).toBe(false);

    expect(isReplanRegressingAcrossAuthBoundary(survivingCompletedFilter, COMPLETED_STEPS)).toBe(
      true
    );
  });

  it("aborts the full output-filtering path instead of splicing the buggy bridge ahead of the 19-step tail", () => {
    expect(() =>
      applyReplanOutputFilters({
        rawNewSteps: BUGGY_RAW_NEW_STEPS,
        completedSteps: COMPLETED_STEPS,
        failedStep: FAILED_STEP,
        originalRemaining: ORIGINAL_REMAINING,
      })
    ).toThrow(StepVerificationError);

    try {
      applyReplanOutputFilters({
        rawNewSteps: BUGGY_RAW_NEW_STEPS,
        completedSteps: COMPLETED_STEPS,
        failedStep: FAILED_STEP,
        originalRemaining: ORIGINAL_REMAINING,
      });
      throw new Error("expected applyReplanOutputFilters to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StepVerificationError);
      expect((err as StepVerificationError).kind).toBe("replan-cycle-detected");
      expect((err as Error).message).toContain("Sign-In");
    }
  });

  it("the protected 19-step originalRemaining tail excludes any Sign-In step and preserves Work History/resume, Screening Questions, Voluntary Demographics, Disability Status, Review, and Submit", () => {
    // Because the guard throws before `plan.splice` ever runs, the plan's
    // remaining tail is never replaced by the buggy 7-step bridge — the
    // 19-step originalRemaining this test seeded is exactly what protects
    // the rest of the authored flow. Assert on its content directly, tying
    // the abort above to the concrete steps the report says got dropped.
    const instructions = ORIGINAL_REMAINING.map((s) => s.instruction);
    expect(instructions).toHaveLength(19);

    const signInPattern = /\bsign[\s-]?in\b/i;
    for (const instruction of instructions) {
      expect(instruction).not.toMatch(signInPattern);
    }

    expect(instructions.some((i) => /work history/i.test(i))).toBe(true);
    expect(instructions.some((i) => /resume/i.test(i))).toBe(true);
    expect(instructions.some((i) => /screening questions/i.test(i))).toBe(true);
    expect(instructions.some((i) => /voluntary demographics/i.test(i))).toBe(true);
    expect(instructions.some((i) => /disability status/i.test(i))).toBe(true);
    expect(instructions.some((i) => /review/i.test(i))).toBe(true);
    expect(instructions.some((i) => /submit/i.test(i))).toBe(true);
  });

  it("regression guard: a safe (non-Sign-In) replan bridge for the same City-field failure clears the pipeline and preserves the full 19-step tail intact", () => {
    const safeBridge: NormalizedStep[] = [
      mk("Fill in the 'City' field with the applicant's city, retrying with the corrected value"),
    ];

    const spliced = applyReplanOutputFilters({
      rawNewSteps: safeBridge,
      completedSteps: COMPLETED_STEPS,
      failedStep: FAILED_STEP,
      originalRemaining: ORIGINAL_REMAINING,
    });

    expect(spliced).toHaveLength(1 + ORIGINAL_REMAINING.length);
    expect(spliced.slice(1).map((s) => s.instruction)).toEqual(
      ORIGINAL_REMAINING.map((s) => s.instruction)
    );
    expect(spliced.slice(1).every((s) => s.origin === "original")).toBe(true);
  });
});
