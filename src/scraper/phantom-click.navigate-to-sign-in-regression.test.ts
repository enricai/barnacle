/**
 * Regression coverage for a gap in `splitIntoActionClauses`'s "to"-delimited
 * clause split: a verb like "navigate"/"go"/"switch"/"scroll"/"open" takes its
 * own direct complement via "to" (e.g. "navigate to the sign in page"), so
 * splitting on every " to " severed the verb from that complement and
 * stranded the sign-in-shaped text in a clause with no recognized action
 * verb, which `splitIntoActionClauses` then discarded as descriptive context.
 * Pins that these verb+"to"+target instructions still corroborate a
 * sign-in-shaped destination.
 */

import { describe, expect, it } from "vitest";

import { isPlausibleStepDestination, splitIntoActionClauses } from "@/scraper/phantom-click";

describe("scraper/phantom-click splitIntoActionClauses — verb+to+complement", () => {
  it.each([
    "navigate to the sign in page",
    "go to sign in",
    "switch to the sign in tab",
    "scroll to the sign in form",
    "open to the sign in modal",
  ])("keeps '%s' as one clause containing the verb's own target", (instruction) => {
    const clauses = splitIntoActionClauses(instruction);
    expect(clauses.some((clause) => /\bsign[\s-]?in\b/.test(clause))).toBe(true);
  });
});

describe("scraper/phantom-click isPlausibleStepDestination — navigate-to-sign-in step", () => {
  it("credits a sign-in-shaped destination when the step's own action is navigating to sign-in", () => {
    expect(
      isPlausibleStepDestination(
        "Navigate to the sign in page and click the submit button",
        "https://example.com/login"
      )
    ).toBe(true);
  });
});
