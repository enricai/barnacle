/**
 * Shared Zod schema for the integrated-questions yes/no + free-text answer
 * block that AppCast-powered ATS plugins require on every submission. Both
 * Appcast and Encompass Health declare the same 20 fields; this module is the
 * single source of truth so a field-type change propagates everywhere.
 *
 * Callers wrap this with `multipartJsonObject()` when the parent payload is
 * multipart — this module exports the raw object so each plugin chooses its
 * own wrapper.
 */

import { z } from "zod/v4";

export const ApplicationAnswersSchema = z.object({
  WorkAuthorization: z.enum(["Yes", "No"]),
  /** Free text; "NA" means no sponsorship required. */
  VisaSponsorship: z.string().min(1),
  NonCompete: z.enum(["Yes", "No"]),
  OIGGSAOFACExcluded: z.enum(["Yes", "No"]),
  /** Free text; "Not Applicable" / "No" / a former-employee ID. */
  FormerEmployee: z.string().min(1),
  /** Free text; "NA" means none. */
  CurrentNonEmployeeId: z.string().min(1),
  OtherOpportunities: z.enum(["Yes", "No"]),
  /** Some tenants (Encompass Health and similar) require a "related to a current
   * employee?" Yes/No radio before submit unlocks. Default "No" is candidate-
   * favorable; pass "Yes" when the applicant has a referral relationship. */
  RelatedToEmployee: z.enum(["Yes", "No"]),
  /** "Previously worked for Encompass Health" (or analogous tenant question).
   * Independent from FormerEmployee which targets the generic AppCast-level
   * former-employee question; this is the tenant-level duplicate that
   * Encompass and similar healthcare ATSes ask separately. Default "No". */
  PreviouslyEmployedAtEncompass: z.enum(["Yes", "No"]),
  /** "Have you ever received sanctions, been on probation, or had limitations
   * placed on your license?" Encompass-style behavioral question.
   * Default "No" is candidate-favorable. */
  EverSanctionedOrOnProbation: z.enum(["Yes", "No"]),
  /** "Have you ever been terminated from or asked to resign from a position?"
   * Encompass-style behavioral question. Default "No". */
  EverTerminated: z.enum(["Yes", "No"]),
  /** "Have you ever been excluded or made ineligible to participate in any
   * federal program?" (OIG/GSA/OFAC-adjacent). Independent from the
   * generic OIGGSAOFACExcluded field above because some tenants ask both
   * the catch-all and the federal-program-specific variant. Default "No". */
  EverExcludedFromFederalProgram: z.enum(["Yes", "No"]),
  /** "Can you present proof of your legal eligibility to work in the United
   * States?" Maps to the documented WorkAuthorization but some tenants ask
   * the proof-of-eligibility framing separately. Default "Yes". */
  LegallyEligibleToWorkUS: z.enum(["Yes", "No"]),
  /** "Can you perform all the required job functions and/or duties of the
   * job for which you are applying?" Default "Yes" is candidate-favorable. */
  CanPerformJobFunctions: z.enum(["Yes", "No"]),
  /** Demographic gender selection. Free text so callers can pass
   * "Male"/"Female"/"Non-binary"/"Prefer not to say"/etc. The fixture
   * defaults to "Prefer not to say" — least-disclosing. */
  Gender: z.string().min(1),
  /** Highest degree obtained. Free text: "High School Diploma", "Associate",
   * "Bachelor", "Master", "Doctoral", etc. */
  Degree: z.string().min(1),
  /** Education level (often duplicates Degree with different wording).
   * Free text. */
  EducationLevel: z.string().min(1),
  /** Full name for E-Signature field. Production callers should pass the
   * applicant's legal full name. */
  SignatureFullName: z.string().min(1),
  /** Age-verification gate ("Are you at least 16/18 years old?"). Defaults
   * to "Yes" so existing callers (Encompass Health, which never asks this)
   * don't break. Threshold varies by tenant — Lifespace asks 16, ClearCompany
   * asks 18 — so the field is threshold-agnostic. */
  MeetsMinimumAge: z.enum(["Yes", "No"]).default("Yes"),
  /** "Have you applied to a Sanford Health or Good Samaritan Society
   * position in the last 6 months?" Tenant-specific question for Sanford /
   * Good Samaritan jobs routed through AppCast. Default "No". */
  AppliedToSanfordOrGoodSamaritanLast6Months: z.enum(["Yes", "No"]).default("No"),
});

export type ApplicationAnswers = z.infer<typeof ApplicationAnswersSchema>;
