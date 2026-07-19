/**
 * Shared Zod schema for the resume attachment block that JSON-envelope ATS
 * plugins require on every submission. Multiple production plugins declare
 * the same four fields; this fragment is extracted so the Buffer/instanceof
 * constraint and the base64 twin are defined once and propagate to every
 * plugin of this shape from one source of truth.
 *
 * `Resume` must be a real Node.js Buffer — multipart form builders call
 * `fd.append("Resume", payload.Resume, ...)` which requires an actual Buffer
 * instance, not a base64 string. `ResumeBase64` carries the same bytes
 * pre-encoded for JSON payloads (e.g. the `interruption_check` body).
 */

import { z } from "zod/v4";

export const ApplicantResumeSchema = z.object({
  Resume: z.instanceof(Buffer),
  ResumeContentType: z.string(),
  ResumeFilename: z.string(),
  ResumeBase64: z.string(),
});

export type ApplicantResume = z.infer<typeof ApplicantResumeSchema>;
