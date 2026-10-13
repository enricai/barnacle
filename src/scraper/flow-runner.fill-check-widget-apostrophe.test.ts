import { describe, expect, it } from "vitest";
import {
  parseCheckStep,
  parseFillStep,
  parseFillValueIntent,
  parseWidgetOptionClickStep,
} from "@/scraper/flow-runner";

describe("apostrophes inside quoted values", () => {
  it("parseFillStep keeps the apostrophe in the value", () => {
    expect(parseFillStep("Fill in the Reason field with 'I don't wish to answer'")).toEqual({
      fieldLabel: "Reason",
      value: "I don't wish to answer",
    });
  });

  it("parseFillValueIntent keeps the apostrophe in fill and type values", () => {
    expect(parseFillValueIntent("Fill the Note field with 'I don't wish to answer'")).toEqual({
      value: "I don't wish to answer",
    });
    expect(parseFillValueIntent("Type 'I don't know' into the Note input")).toEqual({
      value: "I don't know",
    });
  });

  it("parseWidgetOptionClickStep keeps the apostrophe in the option", () => {
    expect(
      parseWidgetOptionClickStep("Click the leaf option 'Friend's referral' to commit")
    ).toEqual({
      option: "Friend's referral",
    });
  });

  it("parseCheckStep keeps the apostrophe in the label", () => {
    expect(parseCheckStep("Check the 'I don't agree' checkbox")).toEqual({
      label: "I don't agree",
    });
  });
});
