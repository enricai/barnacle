/**
 * Regression coverage for the bug report's exact failure shape: a step
 * instruction mentions "sign-in" only in a descriptive/contextual clause
 * naming an unrelated UI landmark, while the step's own action clause is
 * about something else entirely (e.g. account creation). Pins that
 * `isPlausibleStepDestination` vetoes a sign-in-shaped destination in that
 * case rather than crediting it just because "sign-in" appears somewhere in
 * the instruction text.
 */

import { describe, expect, it } from "vitest";

import { isPlausibleStepDestination } from "@/scraper/phantom-click";

describe("scraper/phantom-click isPlausibleStepDestination — contextual sign-in mentions", () => {
  it.each([
    {
      name: "context clause before the action clause mentions sign-in, but the action clause is account creation",
      stepInstruction:
        "Below the newly-revealed name badge/avatar sign-in widget, under the text 'Need a new account?', click the 'Create Profile' button to switch to account registration",
      postUrl: "https://example.com/login",
      expected: false,
    },
    {
      name: "action clause precedes a trailing context clause that mentions sign-in",
      stepInstruction:
        "Click the 'Create Profile' button to switch to account registration, which sits just beneath the existing sign-in widget",
      postUrl: "https://example.com/login",
      expected: false,
    },
    {
      name: "genuine sign-in action clause still corroborates a sign-in-shaped destination",
      stepInstruction: "Click the 'Sign In' button to access your profile",
      postUrl: "https://example.com/login",
      expected: true,
    },
    {
      name: "non-sign-in-shaped destination remains plausible regardless of wording",
      stepInstruction:
        "Below the newly-revealed name badge/avatar sign-in widget, under the text 'Need a new account?', click the 'Create Profile' button to switch to account registration",
      postUrl: "https://example.com/dashboard",
      expected: true,
    },
  ])("$name", ({ stepInstruction, postUrl, expected }) => {
    expect(isPlausibleStepDestination(stepInstruction, postUrl)).toBe(expected);
  });
});
