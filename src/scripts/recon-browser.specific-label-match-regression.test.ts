/**
 * Regression test for `matchByNormalizedLabel`'s substring fallback: when
 * the query label has no exact match and two entries both qualify via
 * bidirectional substring containment — a short/generic sibling label and a
 * longer/specific label that only drifted from an exact match (e.g. a
 * trailing annotation) — the match must resolve to the specific entry, not
 * whichever entry happened to be first in the array.
 */

import { describe, expect, it } from "vitest";

import { filterCompletedFromReplan, type NormalizedStep } from "@/scripts/recon-browser";

describe("recon-browser/filterCompletedFromReplan specificity-ranked label match", () => {
  const mk = (instruction: string): NormalizedStep => ({
    instruction,
    optional: false,
    upload: false,
    origin: "replan",
  });

  it("resolves to the long/specific entry, not the short/generic entry listed first in the DOM", () => {
    const raw = [mk("Fill in the Confirm Password field with 'X1!'"), mk("Click NEXT")];
    const completedSteps = ["Fill in the Confirm Password field with 'X1!'"];
    const bodyHtmlAtFailure =
      "<body>" +
      "<label for='password'>Password</label><input id='password' value='X1!'>" +
      "<label for='confirmPassword'>Confirm Password *</label><input id='confirmPassword' value=''>" +
      "</body>";

    const out = filterCompletedFromReplan(
      raw,
      completedSteps,
      "Some other failed step",
      bodyHtmlAtFailure
    );

    expect(out.map((s) => s.instruction)).toEqual([
      "Fill in the Confirm Password field with 'X1!'",
      "Click NEXT",
    ]);
  });
});
