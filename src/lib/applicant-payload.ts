/**
 * Shared Zod schema for the applicant identity, address, and resume fields
 * that AppCast-powered ATS plugins require on every submission. Both AppCast
 * and Encompass Health declare the same 13 fields; this module is the single
 * source of truth so a field-type change propagates to every AppCast-shaped
 * plugin from one place.
 *
 * Diverging fields (Email, BaseUrl, ClickUrl, JobId, Answers) stay in each
 * plugin's own contract because their types or presence differ across plugins.
 */

import type { z } from "zod/v4";

import { ApplicantAddressSchema } from "@/lib/application-address";
import { ApplicantIdentitySchema } from "@/lib/application-identity";
import { ApplicantResumeSchema } from "@/lib/application-resume";

export const ApplicantContactSchema = ApplicantIdentitySchema.omit({ Email: true })
  .merge(ApplicantAddressSchema)
  .merge(ApplicantResumeSchema);

export type ApplicantContact = z.infer<typeof ApplicantContactSchema>;
