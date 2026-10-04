import { describe, expect, it } from "vitest";

import { isPlausibleStepDestination } from "@/scraper/phantom-click";

describe("scraper/phantom-click isPlausibleStepDestination", () => {
  it.each([
    {
      name: "account-registration instruction landing on a sign-in-shaped path is implausible",
      stepInstruction: "click the Create Account button",
      postUrl: "https://apply.example.com/login",
      expected: false,
    },
    {
      name: "mode-switch instruction landing on a sign-in-shaped path is implausible",
      stepInstruction: "switch to the registration form",
      postUrl: "https://apply.example.com/signin",
      expected: false,
    },
    {
      name: "sign-in instruction landing on a sign-in-shaped path is plausible",
      stepInstruction: "click the Sign In button",
      postUrl: "https://apply.example.com/login",
      expected: true,
    },
    {
      name: "log-in instruction landing on a sign-in-shaped path is plausible",
      stepInstruction: "click the Log In link",
      postUrl: "https://apply.example.com/signin",
      expected: true,
    },
    {
      name: "non-sign-in-shaped destination is plausible regardless of instruction wording",
      stepInstruction: "click the Create Account button",
      postUrl: "https://apply.example.com/register",
      expected: true,
    },
    {
      name: "non-sign-in-shaped destination is plausible even for a sign-in instruction",
      stepInstruction: "click the Sign In button",
      postUrl: "https://apply.example.com/dashboard",
      expected: true,
    },
    {
      name: "unparseable postUrl fails open and is plausible",
      stepInstruction: "click the Create Account button",
      postUrl: "not-a-url",
      expected: true,
    },
    {
      name: "reported-symptom instruction: descriptive context mentions a sign-in form but the step's own action clause is account registration",
      stepInstruction:
        "Below the newly-revealed Email Address/Password sign-in form, under the text 'Don't have an account yet?', click the 'Create Account' button to switch to account registration",
      postUrl: "https://example.com/login",
      expected: false,
    },
    {
      name: "comma-free single-clause sign-in instruction landing on a sign-in-shaped path is plausible",
      stepInstruction: "click the Sign In link",
      postUrl: "https://apply.example.com/login",
      expected: true,
    },
    {
      name: "genuine sign-in action clause after a comma still landing on a sign-in-shaped path is plausible",
      stepInstruction: "On the account options panel, click the Sign In button",
      postUrl: "https://apply.example.com/login",
      expected: true,
    },
  ])("$name", ({ stepInstruction, postUrl, expected }) => {
    expect(isPlausibleStepDestination(stepInstruction, postUrl)).toBe(expected);
  });
});
