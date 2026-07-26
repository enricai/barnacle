/**
 * Schemas for the durable per-run reconciliation record. Extends the submit
 * envelope with named `vivclid`/`jobReference` join keys and adds a distinct
 * beacon/conversion-event kind, so attribution can reconcile Appcast payment
 * per-run instead of only at the cohort level (see feat-002 task context).
 *
 * Both `submission-capture.ts` and `s3-sink.ts` are strictly append-only, so
 * the beacon outcome — which resolves after dispatch already returned and
 * wrote its submit line — is recorded as its own later line rather than a
 * mutation of the submit line. A reader folds the two kinds together by
 * `requestId` to reconstruct one reconciliation record per run.
 *
 * `kind` defaults to `"submit"` because `.barnacle/submissions.ndjson`
 * already holds historical unkinded lines that `s3-sink.ts` has shipped to
 * S3 — a required `kind` would make every one of those lines unparseable.
 */

import { z } from "zod/v4";

/**
 * Submit-side record: the existing submission envelope shape plus named
 * `vivclid`/`jobReference` join keys. Both are nullable-with-default so
 * pre-existing lines that never carried these fields still parse.
 */
export const submitRecordSchema = z.object({
  kind: z.literal("submit").default("submit"),
  siteId: z.string(),
  requestId: z.string(),
  vivclid: z.string().nullable().default(null),
  jobReference: z.string().nullable().default(null),
  inboundPayload: z.unknown(),
  status: z.enum(["submitted", "error"]),
  auditPayload: z.unknown(),
  errorMessage: z.string().nullable(),
  durationMs: z.number(),
  ts: z.string(),
});

export type SubmitRecord = z.infer<typeof submitRecordSchema>;

/**
 * Beacon/conversion-event record: fired independently of, and later than,
 * the submit record for the same `requestId`. Models "submitted but the
 * beacon did not fire" as a distinct dimension from submit outcome.
 */
export const beaconEventSchema = z.object({
  kind: z.literal("beacon"),
  requestId: z.string(),
  siteId: z.string(),
  vivclid: z.string().nullable(),
  jobReference: z.string().nullable(),
  beaconStatus: z.enum(["fired", "failed"]),
  trackingUrl: z.string().nullable(),
  durationMs: z.number(),
  ts: z.string(),
});

export type BeaconEvent = z.infer<typeof beaconEventSchema>;

/**
 * Routes an NDJSON line to `submitRecordSchema` or `beaconEventSchema` by
 * `kind`. Injects `kind: "submit"` ahead of the discriminated union when the
 * field is absent, because `z.discriminatedUnion` reads the raw input's
 * discriminant directly and won't fall back to a member schema's default —
 * confirmed against zod/v4 3.25.76.
 */
export const reconciliationRecordSchema = z.preprocess(
  (value) => {
    if (typeof value === "object" && value !== null && !("kind" in value)) {
      return { ...value, kind: "submit" };
    }
    return value;
  },
  z.discriminatedUnion("kind", [submitRecordSchema, beaconEventSchema])
);

export type ReconciliationRecord = z.infer<typeof reconciliationRecordSchema>;
