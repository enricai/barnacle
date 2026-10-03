import { describe, expect, it } from "vitest";

import { hasPageAlreadyAdvancedPastStep, type NormalizedStep } from "@/scripts/recon-browser";

/**
 * Offline acceptance regression pinning the reported failure mode: a
 * non-submit step's verification cascade exhausts, and the only observed
 * effect is the page reloading back to an earlier, unrelated sign-in-shaped
 * route rather than advancing. Before the destination-plausibility
 * corroboration fix, `hasPageAlreadyAdvancedPastStep` treated any
 * origin/path delta as forward progress and force-credited the step,
 * silently skipping the normal replan path. The fix requires that when the
 * destination looks like a sign-in page, the step's OWN instruction must
 * also be about signing in before the short-circuit fires.
 */

const mk = (instruction: string, extra: Partial<NormalizedStep> = {}): NormalizedStep => ({
  instruction,
  optional: false,
  upload: false,
  origin: "replan",
  ...extra,
});

/** The step's URL at the moment the flow loop started it. */
const STEP_START_URL = "https://apply.example.com/forms/step-4";
/** The live URL after the reload bounced back to an earlier, unrelated sign-in-shaped page. */
const LOGIN_LIKE_URL = "https://apply.example.com/login";

describe("recon-browser reload-to-unrelated-earlier-page regression (offline fixture)", () => {
  it("does not treat a reload back to an unrelated sign-in-shaped page as forward progress when the step itself is not about signing in", () => {
    const nonSignInStepInstruction = "Select 'Weekly' in the 'Digest Frequency' dropdown";

    expect(
      hasPageAlreadyAdvancedPastStep(STEP_START_URL, LOGIN_LIKE_URL, nonSignInStepInstruction)
    ).toBe(false);
  });

  it("consequently does not short-circuit the step into completedSteps-style credit, mirroring the production gate exactly", () => {
    const nonSubmitStep: NormalizedStep = mk(
      "Select 'Weekly' in the 'Digest Frequency' dropdown"
    );

    const shortCircuitFires =
      !nonSubmitStep.submitStep &&
      hasPageAlreadyAdvancedPastStep(STEP_START_URL, LOGIN_LIKE_URL, nonSubmitStep.instruction);

    expect(shortCircuitFires).toBe(false);
  });

  it("still returns true for genuine forward progress on a non-sign-in path, proving the fix narrows false positives without breaking true positives", () => {
    const nextStepUrl = "https://apply.example.com/forms/step-5";
    const nonSignInStepInstruction = "Select 'Weekly' in the 'Digest Frequency' dropdown";

    expect(
      hasPageAlreadyAdvancedPastStep(STEP_START_URL, nextStepUrl, nonSignInStepInstruction)
    ).toBe(true);
  });
});
