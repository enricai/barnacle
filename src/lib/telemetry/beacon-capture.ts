/**
 * Append-only NDJSON writer for beacon-fire outcomes. Beacon-fire resolves
 * strictly after dispatch already returned and wrote its submit line (see
 * `tracking-click.ts`'s fire-and-forget click), so it is recorded as its own
 * later `kind:"beacon"` line rather than a mutation of the submit line — a
 * reader folds the two kinds together by `requestId` (see
 * `reconciliation-record.ts`, `submission-reader.ts`).
 *
 * Writes to the SAME sink as submit lines (`appendSubmissionSinkLine`,
 * feat-003), which is what lets the S3 mirror carry beacon lines for free
 * with zero `s3-sink.ts` changes.
 */

import { formatISO } from "date-fns";
import type { z } from "zod/v4";

import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import type { beaconEventSchema } from "@/lib/telemetry/reconciliation-record";
import { appendSubmissionSinkLine } from "@/lib/telemetry/submission-capture";

const logger = getLogger({ name: "telemetry/beacon-capture" });

const TRACKING_URL_MAX_LENGTH = 120;

/** Validated shape of one beacon-event sample. */
export type BeaconEventSample = z.infer<typeof beaconEventSchema>;

/**
 * Input to `captureBeaconEvent` — `ts` and `kind` are derived internally so
 * callers omit them.
 */
export type BeaconEventInput = Omit<BeaconEventSample, "ts" | "kind">;

/** Options for `captureBeaconEvent`. */
export interface CaptureBeaconEventOptions {
  /** Override the sink path; used in tests to avoid touching the real file. */
  sinkPath?: string;
}

/**
 * Appends one validated NDJSON line for a beacon-fire outcome to the
 * configured submissions sink. Errors are logged and swallowed — telemetry
 * must never break the happy path, matching the never-throw contract
 * `captureSubmissionEnvelope` enforces (submission-capture.ts:52-56); the
 * beacon caller (tracking-click) is already fire-and-forget.
 */
export async function captureBeaconEvent(
  input: BeaconEventInput,
  opts: CaptureBeaconEventOptions = {}
): Promise<void> {
  const sinkPath = opts.sinkPath ?? config.telemetry.submissionsNdjsonPath;
  const sample: BeaconEventSample = {
    ...input,
    kind: "beacon",
    trackingUrl: input.trackingUrl?.slice(0, TRACKING_URL_MAX_LENGTH) ?? null,
    ts: formatISO(new Date()),
  };

  try {
    const line = `${JSON.stringify(sample)}\n`;
    await appendSubmissionSinkLine(sinkPath, line);
  } catch (err) {
    logger.error(`captureBeaconEvent: failed to write to ${sinkPath}: ${String(err)}`);
  }
}
