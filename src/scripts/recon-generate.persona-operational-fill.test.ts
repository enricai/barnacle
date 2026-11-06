import { describe, expect, it } from "vitest";
import { EMPTY_VOCABULARY } from "@/recon/vocabulary";
import { assertNoLeakedPersonaConstant, buildKnownFieldValues } from "@/scripts/recon-generate";

const salary = "Fill the 'What are your salary expectations for this position?' field with '75000'";
const city = "Fill in the City field with 'Austin'";

describe("persona leak net", () => {
  it("operational fill does not trip the net", () => {
    const known = buildKnownFieldValues([salary], EMPTY_VOCABULARY, {});
    expect(() => assertNoLeakedPersonaConstant("x('75000')", known, [salary])).not.toThrow();
  });
  it("a true persona leak throws and names the step", () => {
    const known = buildKnownFieldValues([city], EMPTY_VOCABULARY, {});
    expect(() => assertNoLeakedPersonaConstant("x('Austin')", known, [city])).toThrow(
      /Fill in the City field/
    );
  });
});
