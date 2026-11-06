import { describe, expect, it } from "vitest";
import { extractTaggedPhrases, vetObserveCandidates } from "@/scraper/deep-locator-candidates";

describe("observe candidate vetting with known control aliases", () => {
  const phrases = extractTaggedPhrases("Click the 'Next' button");
  it("accepts a candidate named by a known alias of the step's control", () => {
    const v = vetObserveCandidates([{ description: "Continue" }], phrases);
    expect(v.refuse).toBe(false);
    expect(v.candidate?.description).toBe("Continue");
  });
  it("still refuses a non-alias mismatch", () => {
    const v = vetObserveCandidates([{ description: "Upload resume" }], phrases);
    expect(v.refuse).toBe(true);
  });
});
