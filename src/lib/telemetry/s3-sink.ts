/**
 * Buffered S3 sink that mirrors local NDJSON telemetry so it survives ECS
 * container restarts. Opt-in: entirely inert (no S3Client construction, no
 * network calls) when `config.telemetry.s3.bucket` is unset. Buffers lines
 * in module-level arrays and flushes each non-empty buffer to a single S3
 * object on an interval, early when a buffer crosses
 * `config.telemetry.s3.maxBufferLines`, or at shutdown; a 5000-line hard
 * cap per buffer drops the oldest lines to bound memory during sustained
 * upload failures.
 */

import { randomUUID } from "node:crypto";
import * as os from "node:os";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { formatISO } from "date-fns";

import { config } from "@/config";
import { toErrorMessage } from "@/lib/errors";
import { getLogger } from "@/lib/logging";

const logger = getLogger({ name: "telemetry/s3-sink" });

const HARD_CAP_LINES = 5000;
const SHUTDOWN_FLUSH_TIMEOUT_MS = 20_000;

type BufferName = "calls" | "submissions";

let client: S3Client | undefined;
let callsBuffer: string[] = [];
let submissionsBuffer: string[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
let inFlightFlush: Promise<void> | undefined;

/** Lazily constructs the S3 client. Never called on the bucket-unset path. */
function getClient(): S3Client {
  if (!client) {
    client = new S3Client({ region: config.bedrock.region });
  }
  return client;
}

/** Appends a line to `buffer`, dropping the oldest entries past the hard cap. */
function pushWithCap(buffer: string[], line: string): void {
  buffer.push(line);
  if (buffer.length > HARD_CAP_LINES) {
    buffer.splice(0, buffer.length - HARD_CAP_LINES);
  }
}

/** Prepends `lines` back onto `buffer` after a failed upload, respecting the hard cap. */
function restoreWithCap(buffer: string[], lines: string[]): string[] {
  const merged = [...lines, ...buffer];
  return merged.length > HARD_CAP_LINES ? merged.slice(merged.length - HARD_CAP_LINES) : merged;
}

/** Flushes in the background once `buffer` crosses the configured threshold. */
function maybeThresholdFlush(buffer: string[]): void {
  if (buffer.length < config.telemetry.s3.maxBufferLines) return;
  flushTelemetryToS3().catch((err) => {
    logger.warn(`s3-sink: threshold flush failed: ${toErrorMessage(err)}`);
  });
}

/**
 * Buffers one NDJSON line from the LLM call-capture sink. No-op when no
 * bucket is configured so callers can invoke this unconditionally.
 */
export function bufferCallLine(line: string): void {
  if (!config.telemetry.s3.bucket) return;
  pushWithCap(callsBuffer, line);
  maybeThresholdFlush(callsBuffer);
}

/**
 * Buffers one NDJSON line from the submission-capture sink. No-op when no
 * bucket is configured so callers can invoke this unconditionally.
 */
export function bufferSubmissionLine(line: string): void {
  if (!config.telemetry.s3.bucket) return;
  pushWithCap(submissionsBuffer, line);
  maybeThresholdFlush(submissionsBuffer);
}

/** Builds the S3 object key for one uploaded batch, partitioned by day for lifecycle policies and manual browsing. */
function buildObjectKey(name: BufferName, prefix: string): string {
  const datePartition = formatISO(new Date(), { representation: "date" });
  const hostname = os.hostname();
  const epochMs = Date.now();
  const shortUuid = randomUUID().slice(0, 8);
  return `${prefix}/${name}/${datePartition}/${hostname}-${epochMs}-${shortUuid}.ndjson`;
}

/**
 * Uploads a single non-empty buffer snapshot as one NDJSON object. Returns
 * the lines to restore to the live buffer: empty on success, the full
 * snapshot on failure so the next flush retries them.
 */
async function flushOne(name: BufferName, snapshot: string[]): Promise<string[]> {
  if (snapshot.length === 0) return [];

  const bucket = config.telemetry.s3.bucket;
  if (!bucket) return [];

  try {
    const key = buildObjectKey(name, config.telemetry.s3.prefix);
    await getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: snapshot.join(""),
        ContentType: "application/x-ndjson",
      })
    );
    logger.info(`flushed ${snapshot.length} ${name} line(s) to s3://${bucket}/${key}`);
    return [];
  } catch (err) {
    logger.warn(
      `s3-sink: flush of ${name} buffer failed, retaining for retry: ${toErrorMessage(err)}`
    );
    return snapshot;
  }
}

/**
 * Flushes both buffers to S3, one object per non-empty buffer. Concurrent
 * calls coalesce onto a single in-flight upload — the promise is registered
 * synchronously (before any await) so callers that race in during the same
 * tick observe and await the same flush instead of double-uploading.
 *
 * Snapshot-and-swap: the live buffers are captured and reset to `[]`
 * synchronously (safe under the single-threaded event loop) so lines
 * pushed by callers during the upload land in a fresh buffer rather than
 * being included in, or dropped from, the in-flight snapshot. On failure
 * the snapshot is restored ahead of whatever accumulated during the
 * upload, oldest-first, respecting the hard cap.
 */
export function flushTelemetryToS3(): Promise<void> {
  if (!config.telemetry.s3.bucket) return Promise.resolve();
  if (inFlightFlush) return inFlightFlush;

  const callsSnapshot = callsBuffer;
  const submissionsSnapshot = submissionsBuffer;
  callsBuffer = [];
  submissionsBuffer = [];

  const promise = Promise.all([
    flushOne("calls", callsSnapshot),
    flushOne("submissions", submissionsSnapshot),
  ])
    .then(([callsRemainder, submissionsRemainder]) => {
      callsBuffer = restoreWithCap(callsBuffer, callsRemainder);
      submissionsBuffer = restoreWithCap(submissionsBuffer, submissionsRemainder);
    })
    .finally(() => {
      inFlightFlush = undefined;
    });
  inFlightFlush = promise;
  return promise;
}

/**
 * Starts the periodic flush timer. `.unref()` so a pending timer never
 * blocks process exit — matches the pool.ts timer pattern. No-op when no
 * bucket is configured.
 */
export function startS3SinkTimer(): void {
  if (!config.telemetry.s3.bucket) return;
  if (timer) return;
  timer = setInterval(() => {
    flushTelemetryToS3().catch((err) => {
      logger.warn(`s3-sink: periodic flush failed: ${toErrorMessage(err)}`);
    });
  }, config.telemetry.s3.flushIntervalMs);
  timer.unref();
}

/**
 * Stops the periodic timer and performs a final bounded-time flush. Called
 * during graceful shutdown alongside shutdownStatsD/drainTrackingClicks.
 */
export async function shutdownS3Sink(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  if (!config.telemetry.s3.bucket) return;
  await Promise.race([
    flushTelemetryToS3(),
    new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS)),
  ]);
}

/** Test-only helper: resets all module state to its initial values between test cases. */
export function resetS3Sink(): void {
  if (timer) {
    clearInterval(timer);
  }
  client = undefined;
  callsBuffer = [];
  submissionsBuffer = [];
  timer = undefined;
  inFlightFlush = undefined;
}
