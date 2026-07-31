import { describe, expect, it } from "vitest";

import { EMPTY_VOCABULARY } from "@/recon/vocabulary";
import { resolveStepPayloadField } from "@/scripts/recon-generate";

/**
 * Pins that the ENGINE itself carries no domain knowledge. If someone
 * reintroduces a built-in table as the effective default, these fail.
 */
describe("EMPTY_VOCABULARY — the engine knows nothing", () => {
  const instructions = [
    // Recruiting phrasings: the engine must not recognize these on its own.
    "Fill in the First Name field with 'Reginald'",
    "Enter 'Austin' in the City field",
    "Select 'Texas' from the State dropdown",
    // Cruise phrasings: the false-positives that motivated this change.
    "Select the departure port from the Country dropdown",
    "Open the embarkation City dropdown and select the sailing port",
    "Select the State dropdown for the passenger billing address",
    "Select 'Miami' from the Departure Port City dropdown",
  ];
  for (const instruction of instructions) {
    it(`splices nothing for ${JSON.stringify(instruction)}`, () => {
      expect(
        resolveStepPayloadField(instruction, undefined, undefined, EMPTY_VOCABULARY)
      ).toBeNull();
    });
  }

  it("still honors an explicit payloadField override", () => {
    expect(
      resolveStepPayloadField(
        "Open the destination filter dropdown",
        "destination",
        undefined,
        EMPTY_VOCABULARY
      )
    ).toBe("destination");
  });

  it("resolves an explicit override identically with or without vocabulary", () => {
    // The deprecation nag fires by comparing built-in vs empty outcomes. A step
    // with an explicit payloadField must resolve the same under both, or a site
    // that already declared its fields (disneycruise) gets told to fix nothing.
    const instruction = "Open the destination filter dropdown and select the 'Bahamas' option";
    expect(resolveStepPayloadField(instruction, "destination", undefined, EMPTY_VOCABULARY)).toBe(
      resolveStepPayloadField(instruction, "destination", undefined)
    );
  });

  it("uses a never-matching subject rather than an empty regex", () => {
    // new RegExp("") matches everything, which would silently re-open the
    // false-splice this constant exists to prevent.
    expect(EMPTY_VOCABULARY.subject.test("anything at all")).toBe(false);
  });
});
