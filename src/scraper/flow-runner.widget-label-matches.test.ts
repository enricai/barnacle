import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { hasUnfilledRequiredControlForStep, widgetLabelMatches } from "./flow-runner";

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
    const window = new Window();
    window.document.body.innerHTML = `<label for="p">Postal Code</label><input id="p" required value="">`;
    const target = {
      evaluate: async (expr: string) =>
        new window.Function("document", "window", "CSS", `return (${expr});`)(window.document, window, window.CSS),
    };
    expect(await hasUnfilledRequiredControlForStep(target as never, "Select 'CA' for 'Postal Zip Code'")).toBe(true);
    expect(await hasUnfilledRequiredControlForStep(target as never, "Select 'CA' for 'Favorite Color'")).toBe(false);
  });
  it("neutral example for widgetLabelMatches", () => {
    expect(widgetLabelMatches("Postal Code", "Postal Zip Code")).toBe(true);
  });
});
