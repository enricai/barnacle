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
 * replan dispatcher's raw output comes back the live page has already
 * navigated past the failed step onto the next section of a multi-step web
 * form. The replanner, working from a stale snapshot, re-authors the entire
 * already-completed entry form instead of recognizing the page moved on.
 *
 * **What this pins:** the same composed splice-time output-filtering path as
 * `recon-browser.destructive-replan-regression.test.ts`'s `applyReplanOutputFilters`
 * harness (`filterCompletedFromReplan` -> `isReplanReproposingFailedStep` ->
 * `isReplanRegressingAcrossAuthBoundary` -> `filterReplanDuplicatingNextAuthored`
 * -> splice), extended with the deterministic `hasPageAlreadyAdvancedPastStep`
 * predicate (`recon-browser.ts`) as a leading gate: when the failure-time and
 * post-replan URLs show the page already advanced past the failed step, the
 * pipeline must short-circuit to a single "page already advanced -- no action
 * needed" bridge step plus the untouched original remaining tail, discarding
 * the replanner's re-authored steps entirely — never accepting the
 * re-authored form fields and never throwing the re-proposed-just-failed-step
 * abort (both of which the pre-URL-check pipeline would otherwise produce).
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
/** The live URL by the time the replan dispatcher's raw output comes back — the page already moved on. */
const POST_REPLAN_URL = "https://forms.example.com/signup/step-3";

/** The report's originalRemaining tail — the authored sub-sequence the guard exists to protect. */
const ORIGINAL_REMAINING: NormalizedStep[] = [
  "Select 'Weekly' in the 'Digest Frequency' dropdown",
  "Select 'Product Updates' and 'Community Events' in the 'Topics' checkboxes",
  "Click the 'Save Preferences' button",
  "Click the 'Finish' button to complete signup",
].map((instruction) => mk(instruction, { origin: "original" }));

/**
 * The buggy raw replanner output: re-authors the entire earlier form (email,
 * name, continue, captcha) instead of recognizing the page already advanced
 * past all of it.
 */
const BUGGY_RAW_NEW_STEPS: NormalizedStep[] = [
  "Fill in the 'Email' field with the applicant's email address",
  "Fill in the 'Full Name' field with the applicant's full legal name",
  "Click the 'Continue' button to move past the newsletter signup form",
  "Solve the captcha challenge shown on the signup form",
].map((instruction) => mk(instruction));

/** The bridge step the pipeline must emit in place of the replanner's raw output when the page already advanced. */
const ALREADY_ADVANCED_BRIDGE = "page already advanced -- no action needed";

/**
 * Reproduces the composed splice-time pipeline `main()` runs on
 * `replanRemainingFlow`'s raw output, extended with the already-advanced
 * predicate as a leading gate ahead of the existing filter/guard chain —
 * mirrors `recon-browser.destructive-replan-regression.test.ts`'s
 * `applyReplanOutputFilters` structure.
 */
function applyReplanOutputFilters(params: {
  rawNewSteps: readonly NormalizedStep[];
  completedSteps: readonly string[];
  failedStep: string;
  originalRemaining: readonly NormalizedStep[];
  stepStartUrl: string;
  currentUrl: string;
}): NormalizedStep[] {
  const { rawNewSteps, completedSteps, failedStep, originalRemaining, stepStartUrl, currentUrl } =
    params;

  if (hasPageAlreadyAdvancedPastStep(stepStartUrl, currentUrl)) {
    return [mk(ALREADY_ADVANCED_BRIDGE, { origin: "replan" }), ...originalRemaining];
  }

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
  it("detects the page already advanced past the failed step by the time the raw replan output arrives", () => {
    expect(hasPageAlreadyAdvancedPastStep(STEP_START_URL, POST_REPLAN_URL)).toBe(true);

    // Sanity: none of the buggy raw steps are already-completed or a
    // re-emission of the failed step, so without the already-advanced gate
    // they would sail through the existing filters unfiltered.
    const survivingCompletedFilter = filterCompletedFromReplan(
      BUGGY_RAW_NEW_STEPS,
      COMPLETED_STEPS,
      FAILED_STEP
    );
    expect(survivingCompletedFilter.length).toBeGreaterThan(0);
    expect(isReplanReproposingFailedStep(survivingCompletedFilter, FAILED_STEP)).toBe(false);
  });

  it("short-circuits to a single already-advanced bridge step plus the untouched original tail, instead of splicing the re-authored form or aborting", () => {
    const spliced = applyReplanOutputFilters({
      rawNewSteps: BUGGY_RAW_NEW_STEPS,
      completedSteps: COMPLETED_STEPS,
      failedStep: FAILED_STEP,
      originalRemaining: ORIGINAL_REMAINING,
      stepStartUrl: STEP_START_URL,
      currentUrl: POST_REPLAN_URL,
    });

    expect(spliced).toHaveLength(1 + ORIGINAL_REMAINING.length);
    expect(spliced[0]!.instruction).toBe(ALREADY_ADVANCED_BRIDGE);

    expect(spliced.slice(1).map((s) => s.instruction)).toEqual(
      ORIGINAL_REMAINING.map((s) => s.instruction)
    );
    expect(spliced.slice(1).every((s) => s.origin === "original")).toBe(true);

    // The re-authored earlier-form steps must never appear in the spliced output.
    const instructions = spliced.map((s) => s.instruction);
    for (const reauthored of BUGGY_RAW_NEW_STEPS.map((s) => s.instruction)) {
      expect(instructions).not.toContain(reauthored);
    }
  });

  it("does not throw the re-proposed-just-failed-step abort when the page already advanced", () => {
    expect(() =>
      applyReplanOutputFilters({
        rawNewSteps: BUGGY_RAW_NEW_STEPS,
        completedSteps: COMPLETED_STEPS,
        failedStep: FAILED_STEP,
        originalRemaining: ORIGINAL_REMAINING,
        stepStartUrl: STEP_START_URL,
        currentUrl: POST_REPLAN_URL,
      })
    ).not.toThrow();
  });

  it("regression guard: when the page did NOT advance, the pipeline falls through to the existing filter/guard chain unchanged", () => {
    const safeBridge: NormalizedStep[] = [
      mk("Solve the captcha challenge to confirm the signup form, retrying after a short wait"),
    ];

    const spliced = applyReplanOutputFilters({
      rawNewSteps: safeBridge,
      completedSteps: COMPLETED_STEPS,
      failedStep: FAILED_STEP,
      originalRemaining: ORIGINAL_REMAINING,
      stepStartUrl: STEP_START_URL,
      currentUrl: STEP_START_URL,
    });

    expect(spliced).toHaveLength(1 + ORIGINAL_REMAINING.length);
    expect(spliced[0]!.instruction).toBe(safeBridge[0]!.instruction);
    expect(spliced.slice(1).map((s) => s.instruction)).toEqual(
      ORIGINAL_REMAINING.map((s) => s.instruction)
    );
  });
});
