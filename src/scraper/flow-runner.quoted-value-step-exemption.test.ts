import { describe, expect, it } from "vitest";
import { stepQuotesValueNotControlName, tailRetargetPhrasesForStep } from "@/scraper/flow-runner";

/**
 * Pins the shared quoted-value-step predicate: steps whose quoted text is a
 * value (fill/type/select/radio) are exempt from the click-target phrase
 * guard, while a plain click naming a control is not.
 */

const EXEMPT_STEPS = [
  "Fill in the Email field with 'jane@example.com'",
  "Fill in the Email field in Section 1 with 'jane@example.com'",
  "Type 'jane@example.com' into the Email field",
];

const SELECT_RADIO_STEPS = [
  "Select 'Option A' from the Category dropdown",
  "Click the 'Yes' answer for the question 'Are you at least 18 years old?'",
];

describe("quoted-value step exemption", () => {
  it.each(EXEMPT_STEPS)("exempts %s", (step) => {
    expect(stepQuotesValueNotControlName(step)).toBe(true);
    expect(tailRetargetPhrasesForStep(step)).toEqual([]);
  });

  it.each(SELECT_RADIO_STEPS)("keeps select/radio exempt: %s", (step) => {
    expect(stepQuotesValueNotControlName(step)).toBe(true);
    expect(tailRetargetPhrasesForStep(step)).toEqual([]);
  });

  it("does not exempt a plain click step", () => {
    const step = "Click the 'Create Account' button";
    expect(stepQuotesValueNotControlName(step)).toBe(false);
    expect(tailRetargetPhrasesForStep(step)).toEqual(["Create Account"]);
  });
});
