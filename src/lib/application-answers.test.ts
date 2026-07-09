import { describe, expect, it } from "vitest";

import { ApplicationAnswersSchema, RunIntakeAnswersSchema } from "@/lib/application-answers";

const VALID_ANSWERS = {
  WorkAuthorization: "Yes",
  VisaSponsorship: "NA",
  NonCompete: "No",
  OIGGSAOFACExcluded: "No",
  FormerEmployee: "Not Applicable",
  CurrentNonEmployeeId: "NA",
  OtherOpportunities: "Yes",
  RelatedToEmployee: "No",
  PreviouslyEmployedAtEncompass: "No",
  EverSanctionedOrOnProbation: "No",
  EverTerminated: "No",
  EverExcludedFromFederalProgram: "No",
  LegallyEligibleToWorkUS: "Yes",
  CanPerformJobFunctions: "Yes",
  Gender: "Prefer not to say",
  Degree: "Nursing",
  EducationLevel: "Bachelor's Degree",
  SignatureFullName: "Jane Doe",
} as const;

describe("ApplicationAnswersSchema", () => {
  it("parses a valid answer block with all required fields", () => {
    const result = ApplicationAnswersSchema.safeParse(VALID_ANSWERS);
    expect(result.success).toBe(true);
  });

  it("rejects an invalid enum value on a boolean field", () => {
    const result = ApplicationAnswersSchema.safeParse({
      ...VALID_ANSWERS,
      WorkAuthorization: "Maybe",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty string on a free-text field", () => {
    const result = ApplicationAnswersSchema.safeParse({
      ...VALID_ANSWERS,
      SignatureFullName: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { Gender: _removed, ...rest } = VALID_ANSWERS;
    const result = ApplicationAnswersSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects the same incomplete body that RunIntakeAnswersSchema accepts (regression guard)", () => {
    const { Gender, Degree, EducationLevel, SignatureFullName, ...intakeBase } = VALID_ANSWERS;
    const result = ApplicationAnswersSchema.safeParse(intakeBase);
    expect(result.success).toBe(false);
  });
});

describe("RunIntakeAnswersSchema", () => {
  const { Gender, Degree, EducationLevel, SignatureFullName, ...INTAKE_BASE } = VALID_ANSWERS;

  it("accepts a body with all four detector fields absent", () => {
    const result = RunIntakeAnswersSchema.safeParse(INTAKE_BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.Gender).toBe("");
      expect(result.data.Degree).toBe("");
      expect(result.data.EducationLevel).toBe("");
      expect(result.data.SignatureFullName).toBe("");
    }
  });

  it("accepts a body with all four detector fields as empty strings", () => {
    const result = RunIntakeAnswersSchema.safeParse({
      ...INTAKE_BASE,
      Gender: "",
      Degree: "",
      EducationLevel: "",
      SignatureFullName: "",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a body with some detector fields absent and others populated", () => {
    const result = RunIntakeAnswersSchema.safeParse({
      ...INTAKE_BASE,
      Gender: "Female",
      SignatureFullName: "Jane Doe",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.Degree).toBe("");
      expect(result.data.EducationLevel).toBe("");
    }
  });

  it("still rejects an invalid enum value on a boolean field", () => {
    const result = RunIntakeAnswersSchema.safeParse({
      ...INTAKE_BASE,
      WorkAuthorization: "Maybe",
    });
    expect(result.success).toBe(false);
  });
});
