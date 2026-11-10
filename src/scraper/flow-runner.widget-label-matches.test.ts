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
  it("ignores a trailing empty-value placeholder on the widget label", () => {
    expect(widgetLabelMatches("Country Code — Make a Selection —", "Phone Country Code")).toBe(
      true
    );
    expect(widgetLabelMatches("Number — Make a Selection —", "Mobile Phone Number")).toBe(true);
    expect(widgetLabelMatches("State — Make a Selection —", "Home State")).toBe(true);
    expect(widgetLabelMatches("State — Make a Selection —", "Country Code")).toBe(false);
  });
});
