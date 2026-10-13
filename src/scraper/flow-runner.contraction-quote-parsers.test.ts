import { describe, expect, it } from "vitest";
import {
  parseCheckStep,
  parseFillStep,
  parseFillValueIntent,
  parseSelectStep,
} from "@/scraper/flow-runner";

describe("step parsers pair quotes contraction-aware", () => {
  it("keeps an apostrophe inside a fill value", () => {
    expect(parseFillStep("Fill the name field with 'O'Brien'")).toEqual({
      fieldLabel: "name",
      value: "O'Brien",
    });
  });

  it("keeps a contraction inside a fill value intent", () => {
    expect(parseFillValueIntent("Fill in with 'don't know'")).toEqual({ value: "don't know" });
  });

  it("keeps a contraction inside a select option", () => {
    expect(parseSelectStep("Select 'I don't know' for the 'Experience' question")?.option).toBe(
      "I don't know"
    );
  });

  it("keeps a contraction inside a checkbox label", () => {
    expect(parseCheckStep("Check the 'I don't agree' checkbox")).toEqual({
      label: "I don't agree",
    });
  });
});
