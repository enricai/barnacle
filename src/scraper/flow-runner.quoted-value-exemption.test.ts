import { describe, expect, it } from "vitest";

import { stepQuotesValueNotControlName, tailRetargetPhrasesForStep } from "@/scraper/flow-runner";

const EXEMPT_STEPS = [
  "Fill in the X field with 'v'",
  "Fill in the X field in Section 1 with 'v'",
  "Fill in the Job Title field in Work Experience 1 with 'Registered Nurse'",
  "Type 'v' into the X field",
  "Select 'Option A' from the Country dropdown",
  "Click the 'Yes' radio button for the 'Are you eligible?' question",
];

describe("quoted-value exemption predicate", () => {
  it.each(EXEMPT_STEPS)("exempts %s and yields no target phrases", (step) => {
    expect(stepQuotesValueNotControlName(step)).toBe(true);
    expect(tailRetargetPhrasesForStep(step)).toEqual([]);
  });

  it("does not exempt a plain click and keeps its control name", () => {
    const step = "Click the 'Create Account' button";
    expect(stepQuotesValueNotControlName(step)).toBe(false);
    expect(tailRetargetPhrasesForStep(step)).toEqual(["Create Account"]);
  });
});
