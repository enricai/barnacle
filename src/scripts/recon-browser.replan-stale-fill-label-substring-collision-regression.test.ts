/**
 * Regression test for `filterCompletedFromReplan` pinning the exact defect
 * shape from the report: a confirmation-style field whose live/DOM
 * accessible name has drifted from the step's own quoted label (e.g. a
 * trailing required-marker glyph) has NO exact normalized-label match, so
 * resolution falls back to bidirectional substring containment. Before the
 * specificity-ranked fix, `Array.prototype.find` returned whichever
 * qualifying entry came first — an earlier, shorter sibling label (e.g.
 * "Password") — rather than the longer, more specific label that actually
 * identifies the query field. That wrongly credited the sibling's
 * still-filled value to the query field, so a genuinely-reset "Verify New
 * Password" field read as non-stale and its re-fill step was silently
 * dropped from the replanned bridge.
 */

import { describe, expect, it } from "vitest";
import type { FieldValueAtFailure } from "@/scraper/flow-runner";
import { filterCompletedFromReplan, type NormalizedStep } from "@/scripts/recon-browser";

describe("recon-browser/filterCompletedFromReplan label-substring-collision with wording drift", () => {
  const mk = (instruction: string): NormalizedStep => ({
    instruction,
    optional: false,
    upload: false,
    origin: "replan",
  });

  const raw = [
    mk("Fill in the Password field with 'X1!'"),
    mk("Fill in the Verify New Password field with 'X1!'"),
    mk("Click SUBMIT"),
  ];
  const completedSteps = [
    "Fill in the Password field with 'X1!'",
    "Fill in the Verify New Password field with 'X1!'",
  ];

  it("keeps the drifted-label sibling's refill step stale via the fieldValuesAtFailure capture path", () => {
    const fieldValuesAtFailure: FieldValueAtFailure[] = [
      { label: "Password", value: "X1!" },
      { label: "Verify New Password *", value: "" },
    ];

    const out = filterCompletedFromReplan(
      raw,
      completedSteps,
      "Some other failed step",
      null,
      fieldValuesAtFailure
    );

    expect(out.map((s) => s.instruction)).toEqual([
      "Fill in the Verify New Password field with 'X1!'",
      "Click SUBMIT",
    ]);
  });

  it("keeps the drifted-label sibling's refill step stale via the bodyHtmlAtFailure reparse fallback", () => {
    const bodyHtmlAtFailure =
      "<body>" +
      "<label for='password'>Password</label><input id='password' value='X1!'>" +
      "<label for='verifyNewPassword'>Verify New Password *</label>" +
      "<input id='verifyNewPassword' value=''>" +
      "</body>";

    const out = filterCompletedFromReplan(
      raw,
      completedSteps,
      "Some other failed step",
      bodyHtmlAtFailure
    );

    expect(out.map((s) => s.instruction)).toEqual([
      "Fill in the Verify New Password field with 'X1!'",
      "Click SUBMIT",
    ]);
  });

  it("still treats an unambiguous exact-match field as stale when genuinely reset", () => {
    const sanityRaw = [mk("Fill in the Email field with 'user@example.com'"), mk("Click SUBMIT")];
    const sanityCompleted = ["Fill in the Email field with 'user@example.com'"];
    const fieldValuesAtFailure: FieldValueAtFailure[] = [{ label: "Email", value: "" }];

    const out = filterCompletedFromReplan(
      sanityRaw,
      sanityCompleted,
      "Some other failed step",
      null,
      fieldValuesAtFailure
    );

    expect(out.map((s) => s.instruction)).toEqual([
      "Fill in the Email field with 'user@example.com'",
      "Click SUBMIT",
    ]);
  });
});
