import { describe, expect, it } from "vitest";
import { StepVerificationError } from "@/scraper/errors";
import {
  filterCompletedFromReplan,
  filterReplanDuplicatingNextAuthored,
  isReplanReproposingFailedStep,
  type NormalizedStep,
} from "@/scripts/recon-browser";

/**
 * Regression test for recon item 2: a global replan must re-fill a form-fill
 * step's fields when an intervening step has reset them in the live DOM,
 * rather than trusting the stale `completedSteps` record purely on
 * instruction-string identity.
 *
 * **Scenario:** a step fills two Work-History fields and is credited
 * complete; an intervening "reopen the panel" step resets those two fields
 * in the live DOM; a later step fails and the LLM replanner proposes a
 * bridge that re-proposes filling those same two fields (worded identically
 * to the original authored steps, which is the LLM's natural behavior when
 * asked to "get the form back to a submittable state"). This test runs that
 * raw bridge through the exact splice-time filter pipeline `main()` runs on
 * `replanRemainingFlow`'s output (`filterCompletedFromReplan` ->
 * `isReplanReproposingFailedStep` -> `filterReplanDuplicatingNextAuthored`,
 * mirrored from `recon-browser.destructive-replan-regression.test.ts`).
 *
 * `filterCompletedFromReplan` (`recon-browser.ts`) now accepts an optional
 * `bodyHtmlAtFailure` snapshot of the failure-time DOM. A completed step
 * that parses as a fill (`parseFillStep`) is only trusted as still-complete
 * when its expected value is still present in that DOM — so a reset fill's
 * re-fill proposal survives the filter instead of being dropped as
 * "already completed", and the bridge is spliced in rather than the whole
 * recovery being discarded via `isReplanReproposingFailedStep`.
 *
 * A sibling case proves the still-valid-fill path is untouched: when the
 * failure-time DOM still contains both fields' values, the re-fill
 * proposals are dropped exactly as before.
 */

const mk = (instruction: string, extra: Partial<NormalizedStep> = {}): NormalizedStep => ({
  instruction,
  optional: false,
  upload: false,
  origin: "replan",
  ...extra,
});

const COMPANY_NAME_STEP =
  "In the work history entry form, fill in the 'Company Name' field with 'General Hospital'";
const JOB_TITLE_STEP =
  "In the work history entry form, fill in the 'Job Title' field with 'Registered Nurse'";
const REOPEN_PANEL_STEP = "Click the 'Edit' button to reopen the Work History entry panel";
const SAVE_STEP = "Click the 'Save' button to save the Work History entry";

/** Steps already credited complete before the reopen wiped the two fields. */
const COMPLETED_STEPS = [COMPANY_NAME_STEP, JOB_TITLE_STEP, REOPEN_PANEL_STEP];

const FAILED_STEP = SAVE_STEP;

/** Authored steps still ahead of the failed step, unrelated to the reset fields. */
const ORIGINAL_REMAINING: NormalizedStep[] = [
  "Click the 'Next' button to advance to Education History",
].map((instruction) => mk(instruction, { origin: "original" }));

/**
 * A raw replanner bridge that (correctly, given the reopened panel actually
 * cleared the fields) proposes to re-fill the two reset fields, worded
 * identically to the original authored steps, before retrying Save.
 */
const RAW_REPLAN_BRIDGE: NormalizedStep[] = [COMPANY_NAME_STEP, JOB_TITLE_STEP, SAVE_STEP].map(
  (instruction) => mk(instruction)
);

/** Failure-time DOM after REOPEN_PANEL_STEP wiped the two reset fields. */
const BODY_HTML_WITH_FIELDS_RESET =
  "<body><input name='company' value=''><input name='title' value=''></body>";

/** Failure-time DOM where both fields' values are still present (unchanged behavior). */
const BODY_HTML_WITH_FIELDS_STILL_SET =
  "<body><input name='company' value='General Hospital'><input name='title' value='Registered Nurse'></body>";

/** Mirrors the splice-time pipeline `main()` runs on `replanRemainingFlow`'s raw output. */
function applyReplanOutputFilters(params: {
  rawNewSteps: readonly NormalizedStep[];
  completedSteps: readonly string[];
  failedStep: string;
  originalRemaining: readonly NormalizedStep[];
  bodyHtmlAtFailure?: string | null;
}): NormalizedStep[] {
  const { rawNewSteps, completedSteps, failedStep, originalRemaining, bodyHtmlAtFailure } = params;

  const newSteps = filterCompletedFromReplan(
    rawNewSteps,
    completedSteps,
    failedStep,
    bodyHtmlAtFailure
  );
  if (isReplanReproposingFailedStep(newSteps, failedStep)) {
    throw new StepVerificationError(
      "replan re-proposed only the just-failed step with no new bridge",
      "replan-cycle-detected"
    );
  }

  const taggedNewSteps = filterReplanDuplicatingNextAuthored(
    newSteps.map((s) => ({ ...s, origin: "replan" as const })),
    originalRemaining
  );
  return [...taggedNewSteps, ...originalRemaining];
}

describe("global-replan completedSteps trust regression (recon item 2, offline fixture)", () => {
  it("re-fill proposals for fields reset in the failure-time DOM survive filterCompletedFromReplan", () => {
    const filtered = filterCompletedFromReplan(
      RAW_REPLAN_BRIDGE,
      COMPLETED_STEPS,
      FAILED_STEP,
      BODY_HTML_WITH_FIELDS_RESET
    );
    const instructions = filtered.map((s) => s.instruction);

    // Fixed behavior: the two fields the intervening reopen step actually
    // reset are absent from the failure-time DOM, so their completed-fill
    // record is no longer trusted and the replan's fresh re-fill survives.
    expect(instructions).toContain(COMPANY_NAME_STEP);
    expect(instructions).toContain(JOB_TITLE_STEP);
    expect(instructions).toEqual([COMPANY_NAME_STEP, JOB_TITLE_STEP, FAILED_STEP]);
  });

  it("the recovery bridge splices the re-fill proposals ahead of SAVE_STEP instead of aborting", () => {
    const result = applyReplanOutputFilters({
      rawNewSteps: RAW_REPLAN_BRIDGE,
      completedSteps: COMPLETED_STEPS,
      failedStep: FAILED_STEP,
      originalRemaining: ORIGINAL_REMAINING,
      bodyHtmlAtFailure: BODY_HTML_WITH_FIELDS_RESET,
    });

    expect(result.map((s) => s.instruction)).toEqual([
      COMPANY_NAME_STEP,
      JOB_TITLE_STEP,
      FAILED_STEP,
      ...ORIGINAL_REMAINING.map((s) => s.instruction),
    ]);
  });

  it("still drops the re-fill proposals when the failure-time DOM shows both fields still set (no regression)", () => {
    const filtered = filterCompletedFromReplan(
      RAW_REPLAN_BRIDGE,
      COMPLETED_STEPS,
      FAILED_STEP,
      BODY_HTML_WITH_FIELDS_STILL_SET
    );
    const instructions = filtered.map((s) => s.instruction);

    expect(instructions).not.toContain(COMPANY_NAME_STEP);
    expect(instructions).not.toContain(JOB_TITLE_STEP);
    expect(instructions).toEqual([FAILED_STEP]);
  });

  it("the whole recovery bridge is still discarded (replan-cycle-detected abort) when no fields actually need re-filling", () => {
    expect(() =>
      applyReplanOutputFilters({
        rawNewSteps: RAW_REPLAN_BRIDGE,
        completedSteps: COMPLETED_STEPS,
        failedStep: FAILED_STEP,
        originalRemaining: ORIGINAL_REMAINING,
        bodyHtmlAtFailure: BODY_HTML_WITH_FIELDS_STILL_SET,
      })
    ).toThrow(StepVerificationError);

    try {
      applyReplanOutputFilters({
        rawNewSteps: RAW_REPLAN_BRIDGE,
        completedSteps: COMPLETED_STEPS,
        failedStep: FAILED_STEP,
        originalRemaining: ORIGINAL_REMAINING,
        bodyHtmlAtFailure: BODY_HTML_WITH_FIELDS_STILL_SET,
      });
      expect.unreachable("expected applyReplanOutputFilters to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StepVerificationError);
      expect((error as StepVerificationError).message).toBe(
        "replan re-proposed only the just-failed step with no new bridge"
      );
    }
  });

  it("re-fill proposal survives when the completed step's phrasing defeats parseFillStep (falls back to parseFillValueIntent)", () => {
    // "field FOR WORK EXPERIENCE" inserts words between the field noun and
    // "with", which parseFillStep's canonical `<label> field with '<value>'`
    // regex does not match (returns null) — this phrasing is only recognized
    // via parseFillValueIntent's looser value-only match.
    const looseFillStep = "Fill in the Start Date field for work experience with '01/2020'";
    const looseFailedStep = "Click the 'Continue' button";
    const rawBridge = [mk(looseFillStep), mk(looseFailedStep)];
    const bodyHtmlWithoutValue = "<div>the field was reset and no longer contains that date</div>";

    const filtered = filterCompletedFromReplan(
      rawBridge,
      [looseFillStep],
      looseFailedStep,
      bodyHtmlWithoutValue
    );

    expect(filtered.map((s) => s.instruction)).toEqual([looseFillStep, looseFailedStep]);
  });
});
