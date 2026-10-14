import { describe, expect, it } from "vitest";
import type { NormalizedStep } from "@/scripts/recon-browser";
import { isReplanRegressingAcrossAuthBoundary } from "@/scripts/recon-browser";

/**
 * Regression coverage for `isReplanRegressingAcrossAuthBoundary` matching
 * account-creation patterns against a completed step's own action clauses
 * rather than its whole descriptive text, so a step that merely mentions
 * "Create Account" in a screen title is not mistaken for account creation.
 */

const mk = (instruction: string): NormalizedStep => ({
  instruction,
  optional: false,
  upload: false,
  origin: "replan",
});

const SIGN_IN_BRIDGE = [mk("Click the 'Log In' button to continue")];

describe("recon-browser/isReplanRegressingAcrossAuthBoundary completed-step account-creation scoping", () => {
  it("does not treat a descriptive-only completed step that names the screen title as account creation", () => {
    expect(
      isReplanRegressingAcrossAuthBoundary(SIGN_IN_BRIDGE, [
        "On the 'Sign In' screen (step 1 of 6, titled 'Create Account/Sign In'), click the 'Sign in with email' button to reveal the fields - this click only reveals the form and is not a submit",
      ])
    ).toBe(false);
  });

  it("vetoes when the completed step submits the account creation form", () => {
    expect(
      isReplanRegressingAcrossAuthBoundary(SIGN_IN_BRIDGE, [
        "On the account registration form (Email Address, Password and Verify New Password already filled), click the 'Create Account' button to submit the account creation form",
      ])
    ).toBe(true);
  });

  it("vetoes when the completed step clicks Create Account to switch to the registration form", () => {
    expect(
      isReplanRegressingAcrossAuthBoundary(SIGN_IN_BRIDGE, [
        "Click the 'Create Account' button to switch to the registration form",
      ])
    ).toBe(true);
  });

  it("does not veto on an unrelated completed cookie-consent step", () => {
    expect(
      isReplanRegressingAcrossAuthBoundary(SIGN_IN_BRIDGE, [
        "If a cookie consent banner is shown, click 'Accept' or 'Agree' to dismiss it",
      ])
    ).toBe(false);
  });
});
