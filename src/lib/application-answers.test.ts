import { describe, expect, it } from "vitest";

import { ApplicationAnswersSchema } from "@/lib/application-answers";

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
  it("parses a valid answer block with all 18 fields", () => {
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
});
