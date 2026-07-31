import { describe, expect, it } from "vitest";

import { ApplicantAddressSchema } from "@/lib/application-address";
import { TEST_PERSONA } from "@/testing/persona-fixture";

const VALID_ADDRESS = {
  AddressLine: TEST_PERSONA.Address.Line1,
  City: TEST_PERSONA.Address.City,
  State: TEST_PERSONA.Address.StateAbbreviation,
  PostalCode: TEST_PERSONA.Address.PostalCode,
  Country: TEST_PERSONA.Address.CountryName,
  County: TEST_PERSONA.Address.County,
} as const;

describe("ApplicantAddressSchema", () => {
  it("parses a fully-populated address", () => {
    const result = ApplicantAddressSchema.safeParse(VALID_ADDRESS);
    expect(result.success).toBe(true);
  });

  it.each(["AddressLine", "City", "State", "PostalCode", "Country", "County"] as const)(
    "rejects an empty string for %s",
    (field) => {
      const result = ApplicantAddressSchema.safeParse({ ...VALID_ADDRESS, [field]: "" });
      expect(result.success).toBe(false);
    }
  );

  it.each(["AddressLine", "City", "State", "PostalCode", "Country", "County"] as const)(
    "rejects a missing %s field",
    (field) => {
      const { [field]: _removed, ...rest } = VALID_ADDRESS;
      const result = ApplicantAddressSchema.safeParse(rest);
      expect(result.success).toBe(false);
    }
  );
});
