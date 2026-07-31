/**
 * Shared Zod schema for the four core applicant identity fields (FirstName,
 * LastName, Email, Phone) that are common across all ATS plugins.
 *
 * Email uses `z.email()` (zod/v4 top-level, identical to `z.string().email()`)
 * so either plugin spelling validates correctly. This fragment intentionally
 * excludes address, resume, and job-target fields — those either vary per
 * plugin or are covered by {@link ApplicantContactSchema}.
 */

import { z } from "zod/v4";

export const ApplicantIdentitySchema = z.object({
  FirstName: z.string().min(1),
  LastName: z.string().min(1),
  Email: z.email(),
  Phone: z.string().min(1),
});

export type ApplicantIdentity = z.infer<typeof ApplicantIdentitySchema>;
