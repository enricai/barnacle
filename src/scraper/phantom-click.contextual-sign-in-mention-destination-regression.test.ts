import { describe, expect, it } from "vitest";

import { isPlausibleStepDestination } from "@/scraper/phantom-click";

describe("scraper/phantom-click isPlausibleStepDestination contextual sign-in mention regression", () => {
  it.each([
    {
      name: "reported-symptom instruction: descriptive sign-in context, action clause is account registration",
      stepInstruction:
        "Below the newly-revealed Email Address/Password sign-in form, under the text 'Don't have an account yet?', click the 'Create Account' button to switch to account registration",
      postUrl: "https://example.com/login",
      expected: false,
    },
    {
      name: "unrelated-domain variant: descriptive sign-in context, action clause is a help-center link",
      stepInstruction:
        "Below the newly-revealed sign-in banner, click the Help Center link to open support docs",
      postUrl: "https://example.com/signin",
      expected: false,
    },
    {
      name: "no regression: genuine sign-in action clause still matches a sign-in-shaped destination",
      stepInstruction: "click the Sign In button to continue",
      postUrl: "https://example.com/signin",
      expected: true,
    },
  ])("$name", ({ stepInstruction, postUrl, expected }) => {
    expect(isPlausibleStepDestination(stepInstruction, postUrl)).toBe(expected);
  });
});
