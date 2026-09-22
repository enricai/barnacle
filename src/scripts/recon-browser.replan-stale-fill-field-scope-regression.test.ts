/**
 * Regression test for the field-scoped stale-fill check in
 * `filterCompletedFromReplan`: when two distinct fields are filled with the
 * identical value and the failure-time DOM shows one field reset to empty
 * while the other still holds the value, only the genuinely-reset field's
 * step must be treated as stale. A whole-body substring search over the
 * shared value would find it in the sibling field and wrongly trust both.
 */

import { describe, expect, it } from "vitest";

import { filterCompletedFromReplan, type NormalizedStep } from "@/scripts/recon-browser";

describe("recon-browser/filterCompletedFromReplan field-scoped value collision", () => {
  const mk = (instruction: string): NormalizedStep => ({
    instruction,
    optional: false,
    upload: false,
    origin: "replan",
  });

  it("marks only the reset field's step stale when a sibling field still holds the same value", () => {
    const raw = [
      mk("Fill in the Password field with 'X1!'"),
      mk("Fill in the Confirm Password field with 'X1!'"),
      mk("Click NEXT"),
    ];
    const completedSteps = [
      "Fill in the Password field with 'X1!'",
      "Fill in the Confirm Password field with 'X1!'",
    ];
    const bodyHtmlAtFailure =
      "<body>" +
      "<label for='password'>Password</label><input id='password' value=''>" +
      "<label for='confirmPassword'>Confirm Password</label><input id='confirmPassword' value='X1!'>" +
      "</body>";

    const out = filterCompletedFromReplan(
      raw,
      completedSteps,
      "Some other failed step",
      bodyHtmlAtFailure
    );

    expect(out.map((s) => s.instruction)).toEqual([
      "Fill in the Password field with 'X1!'",
      "Click NEXT",
    ]);
  });
});
