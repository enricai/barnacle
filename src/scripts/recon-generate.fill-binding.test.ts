import { describe, expect, it } from "vitest";
import type { ReconVocabulary } from "@/recon/vocabulary";
import {
  buildKnownFieldValues,
  harvestPersonaBindings,
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
    expect(harvestPersonaBindings([country], vocabulary, {}).get("Canada")).toBe(
      "payload.Country"
    );
  });
});
