/**
 * Canonical ApplicationAnswers fixture for all plugin tests. Centralised so
 * a 20-field answer block is defined once and downstream consumers spread +
 * override the handful of fields they assert differently — a field-type change
 * or new tenant default is a one-edit propagation.
 *
 * Values are seeded from the AppCast/Encompass Health recon run so they satisfy
 * every tenant-level question the question-mapper knows about. Demographic
 * fields default to the least-disclosing option ("Prefer not to say").
 */

import type { ApplicationAnswers } from "@/lib/application-answers";

export const TEST_ANSWERS: ApplicationAnswers = {
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
  SignatureFullName: "Reginald Reconaldo",
  MeetsMinimumAge: "Yes",
  AppliedToSanfordOrGoodSamaritanLast6Months: "No",
};
