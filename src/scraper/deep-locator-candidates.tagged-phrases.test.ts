import { describe, expect, it } from "vitest";
import { extractTaggedPhrases } from "@/scraper/deep-locator-candidates";

describe("extractTaggedPhrases apostrophes", () => {
  it("keeps the target un-negated when quoted copy holds a contraction", () => {
    const result = extractTaggedPhrases("Click 'Don't miss out' then select 'Continue'");
    expect(result).toEqual([
      { text: "Don't miss out", negated: false },
      { text: "Continue", negated: false },
    ]);
  });

  it("preserves genuine negation", () => {
    expect(extractTaggedPhrases("Do NOT click 'Skip', 'Back'")).toEqual([
      { text: "Skip", negated: true },
      { text: "Back", negated: true },
    ]);
  });

  it("treats possessives as plain text", () => {
    expect(extractTaggedPhrases("Click 'Alice's Orders'")).toEqual([
      { text: "Alice's Orders", negated: false },
    ]);
  });

  it("is unchanged without apostrophes", () => {
    expect(extractTaggedPhrases("Click 'Save'")).toEqual([{ text: "Save", negated: false }]);
  });
});
