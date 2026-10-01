/**
 * Composed, multi-cycle regression test for the splice pipeline at
 * recon-browser.ts:3274-3399 (filterCompletedFromReplan then
 * filterReplanDuplicatingNextAuthored, exactly as the live call site chains
 * them). The report's symptom only surfaces across repeated replan cycles:
 * a still-required field that happens to share its value with a sibling
 * field must never be silently dropped from any cycle's spliced step list,
 * even though the sibling's own fill genuinely did complete with that same
 * value. Both functions touch quoted literal values in parts of their
 * logic, so a composition-level test is the only way to pin the contract
 * that decisions key on field identity, never on the quoted value.
 *
 * Simulates a generic 3-field signup flow (Email/Password/Confirm Password,
 * Password and Confirm Password sharing one value) where Password gets
 * silently reset by the page after each failed submit while Confirm
 * Password keeps holding it, failing and replanning three times in a row.
 */
import { describe, expect, it } from "vitest";

import {
  filterCompletedFromReplan,
  filterReplanDuplicatingNextAuthored,
  type NormalizedStep,
} from "@/scripts/recon-browser";

const mk = (instruction: string): NormalizedStep => ({
  instruction,
  optional: false,
  upload: false,
  origin: "original",
});

const SHARED_VALUE = "Secr3t!";
const EMAIL_STEP = "Fill in the Email field with 'user@example.com'";
const PASSWORD_STEP = `Fill in the Password field with '${SHARED_VALUE}'`;
const CONFIRM_PASSWORD_STEP = `Fill in the Confirm Password field with '${SHARED_VALUE}'`;
const SUBMIT_STEP = "Click the 'Create Account' button";

const completedSteps = [EMAIL_STEP, PASSWORD_STEP, CONFIRM_PASSWORD_STEP];
const originalRemaining = [SUBMIT_STEP].map(mk);

/**
 * Password was silently reset by the page after the failed submit; Confirm
 * Password still holds the shared value. A whole-body (not field-scoped)
 * value search would find the shared value present somewhere in the DOM and
 * wrongly credit BOTH fields as still-filled, permanently dropping the
 * Password refill the form actually still requires.
 */
const bodyHtmlAtFailure =
  "<body>" +
  "<label for='em'>Email</label><input id='em' value='user@example.com'>" +
  "<label for='pw'>Password</label><input id='pw' value=''>" +
  `<label for='pw2'>Confirm Password</label><input id='pw2' value='${SHARED_VALUE}'>` +
  "</body>";

/**
 * Splices one replan cycle's raw bridge proposal into the live plan the same
 * way the real call site (recon-browser.ts:3274-3399) does: filter already-
 * completed bridge steps first, then filter bridge steps that duplicate the
 * next authored step's action.
 */
function spliceReplanCycle(rawNewSteps: readonly NormalizedStep[]): NormalizedStep[] {
  const newSteps = filterCompletedFromReplan(
    rawNewSteps,
    completedSteps,
    SUBMIT_STEP,
    bodyHtmlAtFailure
  );
  return filterReplanDuplicatingNextAuthored(
    newSteps.map((s) => ({ ...s, origin: "replan" as const })),
    originalRemaining
  );
}

describe("recon-browser/splice pipeline (filterCompletedFromReplan -> filterReplanDuplicatingNextAuthored) across repeated replan cycles", () => {
  it("keeps the Password refill in every one of 3 replan cycles while correctly dropping the genuinely-satisfied Confirm Password re-proposal", () => {
    // Every cycle, the replanner re-proposes exactly the originally-authored
    // Password and Confirm Password fill steps as its bridge back to Submit
    // — the same shape a real replan echoes completed-looking steps in.
    const rawNewSteps = [PASSWORD_STEP, CONFIRM_PASSWORD_STEP, SUBMIT_STEP].map(mk);

    for (let cycle = 1; cycle <= 3; cycle++) {
      const spliced = spliceReplanCycle(rawNewSteps);
      const instructions = spliced.map((s) => s.instruction);

      expect(instructions, `cycle ${cycle}: Password refill step was dropped`).toContain(
        PASSWORD_STEP
      );
      expect(
        instructions,
        `cycle ${cycle}: Confirm Password should stay correctly dropped (its own control still holds the value)`
      ).not.toContain(CONFIRM_PASSWORD_STEP);
      expect(instructions).toEqual([PASSWORD_STEP]);
    }
  });

  it("drops a bridge step that duplicates the next authored step's action, proving the composed filter still engages", () => {
    const originalRemainingWithFills = [PASSWORD_STEP, CONFIRM_PASSWORD_STEP, SUBMIT_STEP].map(mk);
    const rawNewSteps = [mk(`Retry: fill the Password field with '${SHARED_VALUE}'`)];

    const newSteps = filterCompletedFromReplan(rawNewSteps, [], "some unrelated failed step", null);
    const spliced = filterReplanDuplicatingNextAuthored(
      newSteps.map((s) => ({ ...s, origin: "replan" as const })),
      originalRemainingWithFills
    );

    expect(spliced).toEqual([]);
  });
});
