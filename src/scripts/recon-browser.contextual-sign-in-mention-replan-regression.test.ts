import { describe, expect, it } from "vitest";
import type { NormalizedStep } from "@/scripts/recon-browser";
import { isReplanRegressingAcrossAuthBoundary } from "@/scripts/recon-browser";

/**
 * Regression coverage for `isReplanRegressingAcrossAuthBoundary` scoping its
 * Sign-In match to a freshly-proposed replan step's own action clause (via
 * the shared `splitIntoActionClauses` helper) rather than the step's whole
 * instruction text, so a step that merely mentions sign-in as descriptive
 * context after an account has already been created isn't wrongly classified
 * as a sign-in bridge.
 */

const mk = (instruction: string): NormalizedStep => ({
  instruction,
  optional: false,
  upload: false,
  origin: "replan",
});

const COMPLETED_STEPS = ["Fill in the email field", "Click 'Create Account'"];

describe("recon-browser/isReplanRegressingAcrossAuthBoundary contextual sign-in mention", () => {
  it("does not classify a freshly-authored step as a sign-in bridge when sign-in is only descriptive context", () => {
    expect(
      isReplanRegressingAcrossAuthBoundary(
        [mk("Open the help menu, which sits beside the sign in link, and select FAQ")],
        COMPLETED_STEPS
      )
    ).toBe(false);
  });

  it("still vetoes when the proposed step's own action clause genuinely is a sign-in action", () => {
    expect(
      isReplanRegressingAcrossAuthBoundary(
        [mk("Click the 'Log In' button to continue")],
        COMPLETED_STEPS
      )
    ).toBe(true);
  });
});
