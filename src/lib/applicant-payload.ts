/**
 * Shared Zod schema for the applicant identity, address, and resume fields
 * that AppCast-powered ATS plugins require on every submission. Both AppCast
 * and Encompass Health declare the same 11 fields; this module is the single
 * source of truth so a field-type change propagates to every AppCast-shaped
 * plugin from one place.
 *
 * Diverging fields (Email, BaseUrl, ClickUrl, JobId, Answers) stay in each
 * plugin's own contract because their types or presence differ across plugins.
 */

import { z } from "zod/v4";

export const ApplicantContactSchema = z.object({
  FirstName: z.string().min(1),
  LastName: z.string().min(1),
  Phone: z.string().min(1),

  AddressLine: z.string().min(1),
  City: z.string().min(1),
  State: z.string().min(1),
  PostalCode: z.string().min(1),
  Country: z.string().min(1),
  /** Some tenants (Encompass Health and similar) require a County field
   * nested in the Address group before submit unlocks. */
  County: z.string().min(1),

  Resume: z.instanceof(Buffer),
  ResumeContentType: z.string(),
  ResumeFilename: z.string(),
  ResumeBase64: z.string(),
});

export type ApplicantContact = z.infer<typeof ApplicantContactSchema>;
