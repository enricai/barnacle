import { describe, expect, it } from "vitest";
import { StepVerificationError } from "@/scraper/errors";
import {
  filterCompletedFromReplan,
  filterReplanDuplicatingNextAuthored,
  isReplanReproposingFailedStep,
  type NormalizedStep,
} from "@/scripts/recon-browser";

/**
 * Characterization test for recon item 2 ("may already be intentional"):
 * does a global replan re-fill a form-fill step's fields after an
 * intervening step has reset them, or does it proceed trusting the stale
 * `completedSteps` record purely on instruction-string identity?
 *
 * **Scenario:** a step fills two Work-History fields and is credited
 * complete; an intervening "reopen the panel" step resets those two fields
 * in the live DOM (modeled here as a fact about the page, since
 * `completedSteps`/`filterCompletedFromReplan` never inspect DOM state —
 * see below); a later step fails and the LLM replanner proposes a bridge
 * that re-proposes filling those same two fields (worded identically to
 * the original authored steps, which is the LLM's natural behavior when
 * asked to "get the form back to a submittable state"). This test runs
 * that raw bridge through the exact splice-time filter pipeline `main()`
 * runs on `replanRemainingFlow`'s output (`filterCompletedFromReplan` ->
 * `isReplanReproposingFailedStep` -> `filterReplanDuplicatingNextAuthored`,
 * mirrored from `recon-browser.destructive-replan-regression.test.ts`) and
 * asserts what actually happens today.
 *
 * `filterCompletedFromReplan` (`recon-browser.ts`) only compares
 * `newSteps[].instruction` against the `Set` of already-completed
 * instruction strings — it has no access to and performs no check of
 * current DOM/field state. So a replan bridge proposing to re-fill a
 * field that was reset behind the scenes is indistinguishable, at this
 * filter, from a replan bridge that is genuinely trying to redo already-
 * valid work: both get dropped as "already completed".
 *
 * **What this actually shows (stronger than "the fields are silently
 * skipped"):** dropping the two re-fill proposals leaves only the
 * just-failed step itself in `newSteps`, which trips
 * `isReplanReproposingFailedStep` — `main()`'s very next guard after
 * `filterCompletedFromReplan` — so the ENTIRE replan bridge is discarded
 * as a "replan-cycle-detected" `StepVerificationError` and the run aborts,
 * rather than either re-filling the reset fields or proceeding past them
 * trusting the stale record. The completedSteps trust doesn't just risk a
 * stale-data pass-through; it can convert a valid, necessary recovery
 * bridge into an outright abort.
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

/** Mirrors the splice-time pipeline `main()` runs on `replanRemainingFlow`'s raw output. */
function applyReplanOutputFilters(params: {
  rawNewSteps: readonly NormalizedStep[];
  completedSteps: readonly string[];
  failedStep: string;
  originalRemaining: readonly NormalizedStep[];
}): NormalizedStep[] {
  const { rawNewSteps, completedSteps, failedStep, originalRemaining } = params;

  const newSteps = filterCompletedFromReplan(rawNewSteps, completedSteps, failedStep);
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

describe("global-replan completedSteps trust characterization (recon item 2, offline fixture)", () => {
  it("first: filterCompletedFromReplan alone drops the two re-fill proposals purely on instruction-string identity, with no check of current DOM state", () => {
    const filtered = filterCompletedFromReplan(RAW_REPLAN_BRIDGE, COMPLETED_STEPS, FAILED_STEP);
    const instructions = filtered.map((s) => s.instruction);

    // Current behavior: the re-fill proposals for the two fields the
    // intervening reopen step actually reset are dropped as "already
    // completed" — filterCompletedFromReplan has no visibility into DOM
    // state, only instruction-string membership in completedSteps.
    expect(instructions).not.toContain(COMPANY_NAME_STEP);
    expect(instructions).not.toContain(JOB_TITLE_STEP);
    expect(instructions).toEqual([FAILED_STEP]);
  });

  it("then: the whole recovery bridge is discarded (replan-cycle-detected abort), not silently spliced in without the reset fields", () => {
    // Once the two re-fill steps are gone, `newSteps` is just [FAILED_STEP]
    // — indistinguishable, to `isReplanReproposingFailedStep`, from a
    // replanner that failed to produce any new bridge at all. `main()`'s
    // very next guard after `filterCompletedFromReplan` throws on exactly
    // this shape, aborting the run rather than proceeding on stale trust.
    expect(() =>
      applyReplanOutputFilters({
        rawNewSteps: RAW_REPLAN_BRIDGE,
        completedSteps: COMPLETED_STEPS,
        failedStep: FAILED_STEP,
        originalRemaining: ORIGINAL_REMAINING,
      })
    ).toThrow(StepVerificationError);

    try {
      applyReplanOutputFilters({
        rawNewSteps: RAW_REPLAN_BRIDGE,
        completedSteps: COMPLETED_STEPS,
        failedStep: FAILED_STEP,
        originalRemaining: ORIGINAL_REMAINING,
      });
      expect.unreachable("expected applyReplanOutputFilters to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StepVerificationError);
      expect((error as StepVerificationError).message).toBe(
        "replan re-proposed only the just-failed step with no new bridge"
      );
    }
  });
});
