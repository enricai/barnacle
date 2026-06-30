import { describe, expect, it } from "vitest";

import { ApplicantIdentitySchema } from "@/lib/application-identity";

const VALID_IDENTITY = {
  FirstName: "Jane",
  LastName: "Doe",
  Email: "jane.doe@example.com",
  Phone: "+1 555-867-5309",
} as const;

describe("ApplicantIdentitySchema", () => {
  it("parses a valid identity block", () => {
    const result = ApplicantIdentitySchema.safeParse(VALID_IDENTITY);
    expect(result.success).toBe(true);
  });

  it("rejects an empty FirstName", () => {
    const result = ApplicantIdentitySchema.safeParse({
      ...VALID_IDENTITY,
      FirstName: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty LastName", () => {
    const result = ApplicantIdentitySchema.safeParse({
      ...VALID_IDENTITY,
      LastName: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed Email", () => {
    const result = ApplicantIdentitySchema.safeParse({
      ...VALID_IDENTITY,
      Email: "not-an-email",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { Phone: _removed, ...rest } = VALID_IDENTITY;
    const result = ApplicantIdentitySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});
