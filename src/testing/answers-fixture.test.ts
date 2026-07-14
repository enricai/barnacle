/**
 * Verifies that TEST_ANSWERS satisfies ApplicationAnswersSchema and contains
 * all 22 keys, so downstream consumers can trust the fixture as a valid
 * starting point before spreading overrides.
 */

import { describe, expect, it } from "vitest";

import { ApplicationAnswersSchema } from "@/lib/application-answers";
import { TEST_ANSWERS } from "@/testing/answers-fixture";

const EXPECTED_KEYS: Array<keyof typeof TEST_ANSWERS> = [
  "WorkAuthorization",
  "VisaSponsorship",
  "NonCompete",
  "OIGGSAOFACExcluded",
  "FormerEmployee",
  "CurrentNonEmployeeId",
  "OtherOpportunities",
  "RelatedToEmployee",
  "PreviouslyEmployedAtEncompass",
  "EverSanctionedOrOnProbation",
  "EverTerminated",
  "EverExcludedFromFederalProgram",
  "LegallyEligibleToWorkUS",
  "CanPerformJobFunctions",
  "Gender",
  "Degree",
  "EducationLevel",
  "SignatureFullName",
  "MeetsMinimumAge",
  "AppliedToSanfordOrGoodSamaritanLast6Months",
  "HasOrWillObtainLicense",
  "ReferredByCurrentSanfordOrGoodSamaritanEmployee",
];

describe("TEST_ANSWERS", () => {
  it("passes ApplicationAnswersSchema.safeParse", () => {
    const result = ApplicationAnswersSchema.safeParse(TEST_ANSWERS);
    expect(result.success).toBe(true);
  });

  it("contains all 22 keys", () => {
    expect(EXPECTED_KEYS).toHaveLength(22);
    for (const key of EXPECTED_KEYS) {
      expect(TEST_ANSWERS, `missing key: ${key}`).toHaveProperty(key);
    }
  });

  it("has no extra keys beyond the 22 schema fields", () => {
    expect(Object.keys(TEST_ANSWERS)).toHaveLength(22);
  });
});
