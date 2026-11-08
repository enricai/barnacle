import { describe, expect, it } from "vitest";
import type { ReconVocabulary } from "@/recon/vocabulary";
import {
  buildKnownFieldValues,
  emitBrowserFlowTs,
  harvestPersonaBindings,
  resolveStepPayloadField,
  warnUnmatchedFillSteps,
} from "@/scripts/recon-generate";

const vocabulary: ReconVocabulary = {
  subject: /candidate/i,
  exclusions: [],
  table: [[/\bcountry\b/i, "Country"]],
};
const phoneToken = `'$${"{RECON_PHONE}"}'`;
const salary = "Fill the 'What are your salary expectations for this position?' field with '75000'";

describe("fill-to-vocabulary binding", () => {
  it("does not register an operational free-text fill as a persona constant", () => {
    expect(buildKnownFieldValues([salary], vocabulary, {}).size).toBe(0);
  });
  it("does not register a payloadFieldNone fill", () => {
    const step = { step: "Fill in the Nickname field with 'Bobby'", payloadFieldNone: true };
    expect(buildKnownFieldValues([step], vocabulary, {}).size).toBe(0);
  });
  it("still registers a real identity fill", () => {
    const known = buildKnownFieldValues(["Fill in the City field with 'Austin'"], vocabulary, {});
    expect(known.get("City")).toBe("Austin");
  });
  it("warns once per unmatched fill, naming the step", () => {
    const step = `Fill in the phone 'Number' field with ${phoneToken}`;
    const warnings: string[] = [];
    warnUnmatchedFillSteps([step, "Fill in the Country field with 'US'"], vocabulary, (m) =>
      warnings.push(m)
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("phone 'Number' field");
  });
  it("does not bind a Country Code dropdown to Country, but Country still binds", () => {
    const code = "Choose 'United States (+1)' in the Country Code dropdown";
    const country = "Select 'Canada' in the Country dropdown for the test candidate";
    expect(harvestPersonaBindings([code], vocabulary, {}).size).toBe(0);
    expect(harvestPersonaBindings([country], vocabulary, {}).get("Canada")).toBe("payload.Country");
  });
});

describe("label matching tolerates quote delimiters and code-style variants", () => {
  const phoneVocabulary: ReconVocabulary = {
    subject: /candidate/i,
    exclusions: [],
    table: [
      [/\bphone number\b/i, "MobilePhone"],
      [/\bcountry\b/i, "Country"],
    ],
  };
  it("binds a label whose one word is quoted ('phone 'Number' field')", () => {
    const step = `Fill in the phone 'Number' field with ${phoneToken}`;
    expect(resolveStepPayloadField(step, undefined, false, phoneVocabulary)).toBe("MobilePhone");
  });
  it.each([
    "Select 'US' from the country-code dropdown",
    "Select 'US' from the Country dialing code dropdown",
    "Select 'US' from the 'Country' 'Code' dropdown",
    "Select '+1' from the Country dropdown",
    "Select 'United States (+1)' from the Country dropdown",
  ])("does not bind a phone country-code control to Country: %s", (step) => {
    expect(resolveStepPayloadField(step, undefined, false, phoneVocabulary)).toBeNull();
  });
  // A step that already carries a payload accessor must be judged by its control
  // NAME: the field name inside the accessor is the value, not the label.
  const countryToken = `'$${"{payload.Country}"}'`;
  it.each([
    `Select ${countryToken} in the 'Country Code' dropdown`,
    `Select ${countryToken} in the 'Phone Country Code' dropdown`,
    `Select ${countryToken} in the Country dialing code dropdown`,
  ])("does not rebind a payload-token step on a code-style control: %s", (step) => {
    expect(resolveStepPayloadField(step, undefined, false, phoneVocabulary)).toBeNull();
    expect(harvestPersonaBindings([step], phoneVocabulary, {}).size).toBe(0);
  });
  it("still binds a payload-token step on the plain Country control", () => {
    const step = `Select ${countryToken} in the 'Country' dropdown`;
    expect(resolveStepPayloadField(step, undefined, false, phoneVocabulary)).toBe("Country");
  });
  it("leaves a label-derived free-text fill literal without a persona leak", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "test-agency",
      pascal: "TestAgency",
      baseUrl: "https://example.com",
      isSubmissionFlow: true,
      vocabulary,
      flowSteps: ["Fill in the 'Salary expectations' field with '75000'"],
    });
    expect(code).toContain("'75000'");
  });
});
