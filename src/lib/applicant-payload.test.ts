import { describe, expect, it } from "vitest";

import { ApplicantContactSchema } from "@/lib/applicant-payload";

const VALID_CONTACT = {
  FirstName: "Jane",
  LastName: "Doe",
  Phone: "+1 555-867-5309",
  AddressLine: "123 Main St",
  City: "Birmingham",
  State: "AL",
  PostalCode: "35203",
  Country: "United States",
  County: "Jefferson",
  Resume: Buffer.from("resume content"),
  ResumeContentType: "application/pdf",
  ResumeFilename: "jane-doe-resume.pdf",
  ResumeBase64: Buffer.from("resume content").toString("base64"),
} as const;

describe("ApplicantContactSchema", () => {
  it("parses a fully-populated contact object", () => {
    const result = ApplicantContactSchema.safeParse(VALID_CONTACT);
    expect(result.success).toBe(true);
  });

  it("rejects an empty string on a min(1) field", () => {
    const result = ApplicantContactSchema.safeParse({
      ...VALID_CONTACT,
      FirstName: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty string on any address min(1) field", () => {
    const result = ApplicantContactSchema.safeParse({
      ...VALID_CONTACT,
      City: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { County: _removed, ...rest } = VALID_CONTACT;
    const result = ApplicantContactSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects a non-Buffer Resume", () => {
    const result = ApplicantContactSchema.safeParse({
      ...VALID_CONTACT,
      Resume: "not-a-buffer",
    });
    expect(result.success).toBe(false);
  });
});
