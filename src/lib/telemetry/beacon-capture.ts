/**
 * Append-only NDJSON writer for beacon-fire outcomes. A `"fired"`/`"failed"`
 * beacon resolves strictly after dispatch already returned and wrote its
 * submit line (see `tracking-click.ts`'s fire-and-forget click); a
 * `"skipped"` beacon is instead written synchronously by `dispatch()` itself,
 * before it returns, when there is no `TrackingUrl` to fire-and-forget at
 * all. Either way it is recorded as its own `kind:"beacon"` line rather than
 * a mutation of the submit line — a reader folds the two kinds together by
 * `requestId` (see `reconciliation-record.ts`, `submission-reader.ts`).
 *
 * Writes to the SAME sink as submit lines (`appendSubmissionSinkLine`,
 * feat-003), which is what lets the S3 mirror carry beacon lines for free
 * with zero `s3-sink.ts` changes.
 *
 * `createBeaconOutcomeRecorder` builds on top of `captureBeaconEvent` to
 * give a plugin that manages its own beacon navigation a bound, never-
 * throwing way to report a real `fired`/`failed` outcome for its own run.
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

/** A run's identity, bound once by `createBeaconOutcomeRecorder` so a plugin never supplies it itself. */
export interface BeaconOutcomeRecorderBinding {
  requestId: string;
  siteId: string;
}

/**
 * Plugin-facing input to a bound beacon-outcome recorder — `requestId` and
 * `siteId` are omitted (bound by the factory) and `beaconStatus` excludes
 * `"skipped"`, which stays an engine-owned outcome written by `dispatch()`
 * itself (see `loader.ts`'s `emitBeaconSafely` call). `trackingUrl` and
 * `durationMs` are optional here (unlike `BeaconEventInput`) since a plugin
 * managing its own nav may not have a URL or duration to report.
 */
export interface BeaconOutcomeInput {
  beaconStatus: Extract<BeaconEventInput["beaconStatus"], "fired" | "failed">;
  joinKeys: BeaconEventInput["joinKeys"];
  trackingUrl?: BeaconEventInput["trackingUrl"];
  durationMs?: BeaconEventInput["durationMs"];
}

/** A plugin-callable recorder bound to one run's `requestId`/`siteId`. */
export type BeaconOutcomeRecorder = (
  input: BeaconOutcomeInput,
  opts?: CaptureBeaconEventOptions
) => Promise<void>;

/**
 * Builds a plugin-callable recorder bound to a run's `requestId`/`siteId`,
 * so a plugin that manages its own beacon navigation can report a real
 * `fired`/`failed` outcome without touching `captureBeaconEvent`'s raw input
 * shape or its `ts`/`kind` derivation — `joinKeys` is passed through
 * uninterpreted, matching the opaque, plugin-owned shape precedent in
 * `src/site-plugin.ts`. Wraps the delegated call in the same belt-and-braces
 * try/catch every other beacon call site applies (`emitBeaconSafely` in
 * `loader.ts`, `captureBeaconOutcomeSafely` in `tracking-click.ts`), so a
 * synchronous throw that reaches `captureBeaconEvent` before its own
 * internal try/catch opens can still never escape into the plugin's own
 * execute path.
 */
export function createBeaconOutcomeRecorder(
  binding: BeaconOutcomeRecorderBinding
): BeaconOutcomeRecorder {
  return async (input, opts = {}) => {
    try {
      await captureBeaconEvent(
        {
          requestId: binding.requestId,
          siteId: binding.siteId,
          joinKeys: input.joinKeys,
          beaconStatus: input.beaconStatus,
          trackingUrl: input.trackingUrl ?? null,
          durationMs: input.durationMs ?? 0,
        },
        opts
      );
    } catch (err) {
      logger.error(`createBeaconOutcomeRecorder: capture failed: ${String(err)}`);
    }
  };
}
