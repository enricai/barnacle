import { z } from "zod/v4";

import { statusSchema } from "@/api/schemas/common";
import { beaconEventSchema, submitRecordSchema } from "@/lib/telemetry/reconciliation-record";

/**
 * Upper bound on `limit` so a query can't ask the read path to serialize the
 * entire (potentially 100 MB) submissions sink into one response.
 */
export const SUBMISSIONS_QUERY_LIMIT_MAX = 1000;

const DEFAULT_LIMIT = 100;
const DEFAULT_OFFSET = 0;

/**
 * Query params arrive as strings (or an empty string for a present-but-blank
 * value, e.g. `?limit=`). Both cases mean "not provided" for an optional
 * filter, so they're normalized to `undefined` ahead of the real schema
 * rather than treating `""` as a literal filter value.
 */
function blankToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

const optionalTrimmedString = () => z.preprocess(blankToUndefined, z.string().optional());

/**
 * The read path's beacon-status fold: the record-layer `beaconStatus`
 * options (`beaconEventSchema.shape.beaconStatus`) plus `"not_fired"`, the
 * value `submission-reader.ts` folds in when no beacon line ever arrived.
 * Derived rather than restated so a status added at the record layer can't
 * silently drift from what this read path advertises.
 */
const reconciliationBeaconStatusSchema = z.enum([
  ...beaconEventSchema.shape.beaconStatus.options,
  "not_fired",
]);

/**
 * Querystring contract for the submissions read route. Every field is
 * optional so a caller can filter by any subset of the reconciliation join
 * keys, submit/beacon outcome, or a time window, and page through results.
 */
export const submissionsQuerystringSchema = z.object({
  vivclid: optionalTrimmedString(),
  siteId: optionalTrimmedString(),
  jobReference: optionalTrimmedString(),
  requestId: optionalTrimmedString(),
  status: z.preprocess(blankToUndefined, submitRecordSchema.shape.status.optional()),
  beaconStatus: z.preprocess(blankToUndefined, reconciliationBeaconStatusSchema.optional()),
  from: z.preprocess(blankToUndefined, z.iso.datetime({ offset: true }).optional()),
  to: z.preprocess(blankToUndefined, z.iso.datetime({ offset: true }).optional()),
  limit: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().positive().max(SUBMISSIONS_QUERY_LIMIT_MAX).default(DEFAULT_LIMIT)
  ),
  offset: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().nonnegative().default(DEFAULT_OFFSET)
  ),
});

export type SubmissionsQuerystring = z.infer<typeof submissionsQuerystringSchema>;

/**
 * One reconciled per-run row: the submit record's named join keys and
 * outcome, plus the beacon-fire dimension folded on by `requestId`. Derived
 * from `submitRecordSchema` (feat-002's durable record) rather than
 * restated, so a field added to the writer can't silently drift from what
 * the read path claims to expose — the same re-export-not-duplicate pattern
 * as `src/api/schemas/telemetry.ts`. `inboundPayload`/`auditPayload` are
 * omitted: they're the opaque blob this route exists to stop callers from
 * having to re-parse.
 */
export const reconciliationRowSchema = submitRecordSchema
  .omit({ kind: true, inboundPayload: true, auditPayload: true })
  .extend({
    beaconStatus: reconciliationBeaconStatusSchema,
    trackingUrl: z.string().nullable(),
  });

export type ReconciliationRow = z.infer<typeof reconciliationRowSchema>;

/**
 * Response contract for the submissions read route: the standard envelope
 * plus the reconciled rows and a total count for pagination.
 */
export const submissionsResponseSchema = z.object({
  status: statusSchema,
  submissions: z.array(reconciliationRowSchema),
  total: z.number().int().nonnegative(),
});

export type SubmissionsResponse = z.infer<typeof submissionsResponseSchema>;
