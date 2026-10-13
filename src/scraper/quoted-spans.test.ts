import { describe, expect, it } from "vitest";
import { findQuotedSpans, maskApostrophes, matchAnchored, restoreApostrophes } from "@/scraper/quoted-spans";

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

  it("matchAnchored returns whole spans with apostrophes restored", () => {
    const input = "select 'Women's health' in the 'Don't know?' list";
    const match = matchAnchored(input, /^select '([^']+)' in the '([^']+)' list/);
    expect(match?.groups).toEqual([input, "Women's health", "Don't know?"]);
    expect(match?.start).toBe(0);
    expect(match?.end).toBe(input.length);
  });

  it("matchAnchored returns null when the pattern does not match", () => {
    expect(matchAnchored("click 'Go'", /^select '([^']+)'/)).toBeNull();
  });
});
