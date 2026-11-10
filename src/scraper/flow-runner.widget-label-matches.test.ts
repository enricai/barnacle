import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
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
        new window.Function("document", "window", "CSS", `return (${expr});`)(
          window.document,
          window,
          window.CSS
        ),
    };
    expect(
      await hasUnfilledRequiredControlForStep(target as never, "Select 'CA' for 'Postal Zip Code'")
    ).toBe(true);
    expect(
      await hasUnfilledRequiredControlForStep(target as never, "Select 'CA' for 'Favorite Color'")
    ).toBe(false);
  });
  it("neutral example for widgetLabelMatches", () => {
    expect(widgetLabelMatches("Postal Code", "Postal Zip Code")).toBe(true);
  });
});

describe("required-control probe reads every label source without decoration", () => {
  const probe = async (html: string, question: string): Promise<boolean> => {
    const window = new Window();
    window.document.body.innerHTML = html;
    const target = {
      evaluate: async (expr: string) =>
        new window.Function("document", "window", "CSS", `return (${expr});`)(
          window.document,
          window,
          window.CSS
        ),
    };
    return hasUnfilledRequiredControlForStep(target as never, `Select 'X' for '${question}'`);
  };
  it.each([
    [
      `<label for="p">Postal Code — Make a Selection —</label><input id="p" role="combobox" required>`,
    ],
    [
      `<span id="l">Postal Code - Please select</span><div role="combobox" aria-labelledby="l" aria-required="true"></div>`,
    ],
    [`<label for="p">Postal Code (required)</label><input id="p" role="combobox" required>`],
    [
      `<a role="combobox" aria-required="true" aria-label="Postal Code — Make a Selection —">Make a Selection</a>`,
    ],
  ])("unfilled required control labelled %j is found for the wider question", async (html) => {
    expect(await probe(html, "Home Postal Code")).toBe(true);
    expect(await probe(html, "Favorite Color")).toBe(false);
  });
});
