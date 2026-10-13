import { describe, expect, it } from "vitest";
import { findQuotedSpans, maskApostrophes, restoreApostrophes } from "@/scraper/quoted-spans";

describe("quoted-spans", () => {
  it("ignores contraction apostrophes inside a quoted phrase", () => {
    const input = "under the text 'Don't have an account yet?', click the 'Create Account' button";
    const spans = findQuotedSpans(input);
    expect(spans.map((s) => s.text)).toEqual(["Don't have an account yet?", "Create Account"]);
    for (const s of spans) {
      expect(input.slice(s.start, s.end)).toBe(`'${s.text}'`);
    }
  });

  it("treats a possessive inside quotes as one span", () => {
    expect(findQuotedSpans("'Nurse's Day'").map((s) => s.text)).toEqual(["Nurse's Day"]);
  });

  it("behaves normally without apostrophes", () => {
    expect(findQuotedSpans("click 'Go' now").map((s) => s.text)).toEqual(["Go"]);
    expect(findQuotedSpans("no quotes")).toEqual([]);
  });

  it("preserves length and round-trips", () => {
    const input = "it's 'Don't'";
    const masked = maskApostrophes(input);
    expect(masked).toHaveLength(input.length);
    expect(restoreApostrophes(masked)).toBe(input);
  });
});
