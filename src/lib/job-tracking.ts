/**
 * Shared Zod schema fragment for the optional post-submission tracking-click
 * URL that every plugin may receive. The engine reads `TrackingUrl`
 * site-agnostically in loader.ts (fireTrackingClick) — this fragment is the
 * single source of truth so a type change propagates to every plugin from one
 * place.
 *
 * Compose into a plugin contract via `.extend(JobTrackingSchema.shape)` or
 * `.merge(JobTrackingSchema)` depending on which Zod combinator the plugin
 * already uses.
 */

import { z } from "zod/v4";

export const JobTrackingSchema = z.object({
  TrackingUrl: z.url().optional(),
});

export type JobTracking = z.infer<typeof JobTrackingSchema>;
