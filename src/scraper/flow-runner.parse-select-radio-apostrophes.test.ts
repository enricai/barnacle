import { describe, expect, it } from "vitest";
import { parseRadioStep, parseSelectStep } from "@/scraper/flow-runner";

describe("select/radio parsers with apostrophes", () => {
  it("keeps apostrophes in select option and label", () => {
    expect(parseSelectStep("Select 'Women's health' in the 'Don't know?' dropdown")).toEqual({
      option: "Women's health",
      questionLabel: "Don't know?",
    });
  });
  it("handles a contraction in the radio option and label", () => {
    expect(
      parseRadioStep("click the 'I don't know' answer for the question 'What's next?'")
    ).toEqual({
      option: "I don't know",
      questionLabel: "What's next?",
    });
  });
});
