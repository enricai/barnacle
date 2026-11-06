import { describe, expect, it } from "vitest";
import { widgetLabelMatches } from "./flow-runner";

describe("widgetLabelMatches", () => {
  it("matches token-subset labels in either direction", () => {
    expect(widgetLabelMatches("Phone Country Code", "Country Code")).toBe(true);
    expect(widgetLabelMatches("Country Code", "Phone Country Code")).toBe(true);
  });
  it("rejects unrelated and empty labels", () => {
    expect(widgetLabelMatches("State", "Country Code")).toBe(false);
    expect(widgetLabelMatches("", "Country")).toBe(false);
  });
});
