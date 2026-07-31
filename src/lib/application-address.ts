/**
 * Shared Zod fragment for the six address fields that AppCast-powered plugins
 * (AppCast, Encompass Health) require on every submission. Extracted so a
 * field-type change propagates from one place to every consumer.
 */

import { z } from "zod/v4";

export const ApplicantAddressSchema = z.object({
  AddressLine: z.string().min(1),
  City: z.string().min(1),
  State: z.string().min(1),
  PostalCode: z.string().min(1),
  Country: z.string().min(1),
  /** Applicant's home county. Required by some tenants (Encompass Health and
   * similar) before submit unlocks. */
  County: z.string().min(1),
});

export type ApplicantAddress = z.infer<typeof ApplicantAddressSchema>;
