/**
 * Regression coverage for the bypass-site fix (bugfix-002) scoping
 * `isReplanRegressingAcrossAuthBoundary`'s sign-in match to the replan
 * step's own action clause (via the shared `isPlausibleStepDestination`
 * machinery), instead of a bare word-boundary search anywhere in the full
 * instruction text. Also re-asserts `hasPageAlreadyAdvancedPastStep` — the
 * consumer that already inherits the same action-clause scoping from
 * bugfix-001 with zero edits of its own — isn't tricked by a descriptive
 * sign-in mention either.
 */

import { describe, expect, it } from "vitest";

import { hasPageAlreadyAdvancedPastStep, isReplanRegressingAcrossAuthBoundary } from "@/scripts/recon-browser";
import type { NormalizedStep } from "@/scripts/recon-browser";

describe("recon-browser — contextual sign-in mention does not trip the replan auth-boundary bridge veto", () => {
  const mk = (instruction: string): NormalizedStep => ({
    instruction,
    optional: false,
    upload: false,
    origin: "replan",
  });

  it("does not misclassify a replan step whose action is unrelated but descriptively mentions sign-in", () => {
    expect(
      isReplanRegressingAcrossAuthBoundary(
        [mk("Open the support ticket history, located beside the sign in widget")],
        ["Fill in the account email field", "Click 'Create Account'"]
      )
    ).toBe(false);
  });

  it("still vetoes a genuine sign-in bridge step after an account-creation step", () => {
    expect(
      isReplanRegressingAcrossAuthBoundary(
        [mk("Click the 'Sign In' button")],
        ["Fill in the account email field", "Click 'Create Account'"]
      )
    ).toBe(true);
  });

  it("hasPageAlreadyAdvancedPastStep does not treat a descriptive sign-in mention as already-advanced", () => {
    const result = hasPageAlreadyAdvancedPastStep(
      "https://support.example.com/tickets/new",
      "https://support.example.com/sign-in",
      "Open the support ticket history, located beside the sign in widget"
    );

    expect(result).toBe(false);
  });
});
