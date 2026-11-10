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

describe("required-control probe uses the shared label predicate", () => {
  it("matches a required empty control by token subset", async () => {
    const { JSDOM } = await import("jsdom").catch(() => ({ JSDOM: null }) as never);
    if (!JSDOM) return;
    const dom = new JSDOM(
      `<label for="p">Postal Code</label><input id="p" required value="">`,
      { runScripts: "outside-only" }
    );
    const target = {
      evaluate: async (expr: string) => dom.window.eval(expr),
    };
    const { hasUnfilledRequiredControlForStep } = await import("./flow-runner");
    expect(await hasUnfilledRequiredControlForStep(target as never, "Fill in the Shipping Postal Code")).toBe(true);
    expect(await hasUnfilledRequiredControlForStep(target as never, "Fill in the Favorite Color")).toBe(false);
  });
  it("neutral example for widgetLabelMatches", () => {
    expect(widgetLabelMatches("Postal Code", "Shipping Postal Code")).toBe(true);
  });
});
