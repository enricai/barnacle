/**
 * Schemas for the durable per-run reconciliation record. Extends the submit
 * envelope with an opaque `joinKeys` bag and adds a distinct
 * beacon/conversion-event kind, so a plugin can reconcile its own attribution
 * provider's payment per-run instead of only at the cohort level. `joinKeys`
 * is deliberately untyped `Record<string, unknown>` (matching
 * `SitePluginResult.auditPayload`'s "opaque, plugin-owned shape" precedent in
 * `src/site-plugin.ts`) — core has no business knowing what a given
 * attribution vendor calls its join key.
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
 *
 * `reconciliationRecordSchema`'s preprocess step also folds a legacy
 * top-level `vivclid`/`jobReference` shape into `joinKeys`: before the
 * opaque `joinKeys` bag existed, those two fields were persisted as named
 * top-level keys, and a plain `z.object()` silently drops unrecognized
 * keys — reading an old line through the new schema would otherwise lose
 * its join keys rather than surface them.
 */

import { z } from "zod/v4";

/**
 * Submit-side record: the existing submission envelope shape plus an opaque
 * `joinKeys` bag. Nullable-with-default so pre-existing lines that never
 * carried this field still parse.
 */
export const submitRecordSchema = z.object({
  kind: z.literal("submit").default("submit"),
  siteId: z.string(),
  requestId: z.string(),
  joinKeys: z.record(z.string(), z.unknown()).nullable().default(null),
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
 * `beaconStatus: "skipped"` means no beacon was ever applicable for this run
 * (no usable TrackingUrl, or the plugin manages its own beacon nav — see
 * `dispatch()` in `src/plugins/loader.ts`) — distinct from `"not_fired"`
 * (the reader's fold default for a submit row with no matching beacon line
 * at all), so "submitted but the beacon did not fire" excludes runs that
 * never had a beacon to fire. `"skipped"` is not necessarily terminal for a
 * self-managing plugin: if that plugin later records its own real `fired`/
 * `failed` line for the same `requestId`, `foldReconciliationRecords` in
 * `submission-reader.ts` ranks the real outcome above `"skipped"` and folds
 * to that outcome regardless of which line was written first.
 */
export const beaconEventSchema = z.object({
  kind: z.literal("beacon"),
  requestId: z.string(),
  siteId: z.string(),
  joinKeys: z.record(z.string(), z.unknown()).nullable(),
  beaconStatus: z.enum(["fired", "failed", "skipped"]),
  trackingUrl: z.string().nullable(),
  durationMs: z.number(),
  ts: z.string(),
});

export type BeaconEvent = z.infer<typeof beaconEventSchema>;

/**
 * Folds a legacy top-level `vivclid`/`jobReference` shape into `joinKeys`
 * for a line that doesn't already carry `joinKeys`, so historical lines
 * from before the opaque `joinKeys` bag existed still surface their join
 * keys instead of silently losing them to `z.object()`'s unrecognized-key
 * drop. Only synthesizes a non-null bag when a legacy field was actually
 * present, so lines with neither (e.g. sites that never had these fields)
 * still fall through to `joinKeys`'s own `.default(null)`.
 */
function withLegacyJoinKeys(value: Record<string, unknown>): Record<string, unknown> {
  if ("joinKeys" in value) return value;

  const { vivclid, jobReference, ...rest } = value;
  const legacyJoinKeys =
    vivclid || jobReference
      ? { vivclid: vivclid ?? null, jobReference: jobReference ?? null }
      : null;
  return { ...rest, joinKeys: legacyJoinKeys };
}

/**
 * Routes an NDJSON line to `submitRecordSchema` or `beaconEventSchema` by
 * `kind`. Injects `kind: "submit"` ahead of the discriminated union when the
 * field is absent, because `z.discriminatedUnion` reads the raw input's
 * discriminant directly and won't fall back to a member schema's default —
 * confirmed against zod/v4 3.25.76. Also folds a legacy vivclid/jobReference
 * shape into `joinKeys` (see `withLegacyJoinKeys`) before the union runs.
 */
export const reconciliationRecordSchema = z.preprocess(
  (value) => {
    if (typeof value !== "object" || value === null) return value;
    const withKind = "kind" in value ? value : { ...value, kind: "submit" };
    return withLegacyJoinKeys(withKind as Record<string, unknown>);
  },
  z.discriminatedUnion("kind", [submitRecordSchema, beaconEventSchema])
);

export type ReconciliationRecord = z.infer<typeof reconciliationRecordSchema>;
