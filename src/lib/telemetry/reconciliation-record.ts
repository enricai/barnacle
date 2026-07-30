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
 * `session` (on `submitRecordSchema`) and `sessionIp` (on `beaconEventSchema`)
 * carry the Browserbase session's identity and outbound IP so it's durable
 * per-run telemetry rather than only a log line — every plugin acquires its
 * session the same engine-owned way, so this lands here rather than
 * per-plugin.
 */

import { z } from "zod/v4";

/**
 * The Browserbase session identity and outbound IP a plugin's run used.
 * `ip`/`ipCapturedAt` are nullable independently of `id`/`provider` because
 * the IP is only known after a separate in-session IP-echo navigation, which
 * may never resolve (a disabled capture, a provider with no IP accessor, a
 * timeout) even when the session itself was acquired successfully.
 */
export const sessionTelemetrySchema = z.object({
  id: z.string(),
  provider: z.string(),
  ip: z.string().nullable(),
  ipCapturedAt: z.string().nullable(),
});

export type SessionTelemetry = z.infer<typeof sessionTelemetrySchema>;

/**
 * Submit-side record: the existing submission envelope shape plus an opaque
 * `joinKeys` bag.
 */
export const submitRecordSchema = z.object({
  kind: z.literal("submit"),
  siteId: z.string(),
  requestId: z.string(),
  joinKeys: z.record(z.string(), z.unknown()).nullable(),
  session: sessionTelemetrySchema.nullable(),
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
  sessionIp: z.string().nullable(),
});

export type BeaconEvent = z.infer<typeof beaconEventSchema>;

/**
 * Routes an NDJSON line to `submitRecordSchema` or `beaconEventSchema` by
 * `kind`.
 */
export const reconciliationRecordSchema = z.discriminatedUnion("kind", [
  submitRecordSchema,
  beaconEventSchema,
]);

export type ReconciliationRecord = z.infer<typeof reconciliationRecordSchema>;
