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
    // Real-estate phrasings: the false-positives that motivated this change.
    "Select the neighborhood from the Country dropdown",
    "Open the listing City dropdown and select the metro area",
    "Select the State dropdown for the tenant billing address",
    "Select 'Downtown' from the Neighborhood City dropdown",
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
        "Open the metro filter dropdown",
        "metro",
        undefined,
        EMPTY_VOCABULARY
      )
    ).toBe("metro");
  });

  it("resolves an explicit override identically with or without vocabulary", () => {
    // The deprecation nag fires by comparing built-in vs empty outcomes. A step
    // with an explicit payloadField must resolve the same under both, or a site
    // that already declared its fields (listings-fixture) gets told to fix nothing.
    const instruction = "Open the metro filter dropdown and select the 'Denver' option";
    expect(resolveStepPayloadField(instruction, "metro", undefined, EMPTY_VOCABULARY)).toBe(
      resolveStepPayloadField(instruction, "metro", undefined)
    );
  });

  it("uses a never-matching subject rather than an empty regex", () => {
    // new RegExp("") matches everything, which would silently re-open the
    // false-splice this constant exists to prevent.
    expect(EMPTY_VOCABULARY.subject.test("anything at all")).toBe(false);
  });
});
