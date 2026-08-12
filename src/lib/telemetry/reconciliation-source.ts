/**
 * Durable read path for reconciliation rows: unions the container-local
 * submissions sink with the S3-replicated objects (feat-003's
 * `listSubmissionsS3Objects` + `fetchSubmissionsS3Records`) before folding,
 * so a submit line written by one ECS task and its beacon line written by
 * another both land in the same row instead of two ephemeral, incomplete
 * ones. Merge happens at the record level — before
 * `foldReconciliationRecords` — because folding first would discard the
 * beacon detail a cross-store fold still needs (see
 * `submission-reader.ts`'s `foldReconciliationRecords`).
 *
 * The local sink and its S3 replica both receive the exact same line for
 * every event (`appendSubmissionSinkLine` writes to disk and buffers to S3
 * in the same call), so an overlap between the two stores is an exact JSON
 * duplicate, never a conflicting value — deduping on `kind:requestId:ts` is
 * lossless for that replica case. But `ts` is formatISO second-precision, so
 * two *distinct* beacon lines for the same `requestId` (e.g. dispatch's
 * automatic `skipped` line and a plugin's later self-recorded `fired` line)
 * can land in the same wall-clock second — the dedupe key for beacon
 * records also folds in `beaconStatus` and `trackingUrl` so non-identical
 * beacon outcomes never collide, while submit records keep the plain
 * `kind:requestId:ts` key.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { config } from "@/config";
import { toErrorMessage } from "@/lib/errors";
import { getLogger } from "@/lib/logging";
import type { ReconciliationRecord } from "@/lib/telemetry/reconciliation-record";
import {
  foldReconciliationRecords,
  parseReconciliationLines,
  type ReconciliationRow,
} from "@/lib/telemetry/submission-reader";
import {
  type ListSubmissionsS3ObjectsOptions,
  listSubmissionsS3Objects,
} from "@/lib/telemetry/submissions-s3-objects";
import { fetchSubmissionsS3Records } from "@/lib/telemetry/submissions-s3-reader";

const logger = getLogger({ name: "telemetry/reconciliation-source" });

/** Options for `readDurableReconciliationRows`. */
export interface ReadDurableReconciliationRowsOptions extends ListSubmissionsS3ObjectsOptions {
  /** Override the local sink path; used in tests to avoid touching the real file. */
  sinkPath?: string;
}

/**
 * Reads the local sink into raw records, exactly as `readReconciliationRows`
 * does (`existsSync` + `readFile` + `parseReconciliationLines`), rather than
 * calling `readReconciliationRows` itself — that helper returns already-folded
 * rows, which would drop the beacon detail a cross-store fold needs.
 */
async function readLocalRecords(sinkPath: string): Promise<ReconciliationRecord[]> {
  if (!existsSync(sinkPath)) return [];
  const content = await readFile(sinkPath, "utf8");
  return parseReconciliationLines(content);
}

/**
 * Lists and fetches the S3-replicated records for the window. A rejection
 * anywhere in the S3 path (listing or fetch) is logged and swallowed rather
 * than propagated, so an S3 outage degrades the answer to local-only instead
 * of failing the whole read.
 */
async function readS3Records(
  opts: ListSubmissionsS3ObjectsOptions
): Promise<ReconciliationRecord[]> {
  try {
    const keys = await listSubmissionsS3Objects(opts);
    if (keys.length === 0) return [];
    return await fetchSubmissionsS3Records(keys);
  } catch (err) {
    logger.warn(
      `reconciliation-source: S3 read failed, falling back to local-only rows: ${toErrorMessage(err)}`
    );
    return [];
  }
}

/**
 * Dedupe key for a raw record: the same line written to both stores
 * collapses to one. Beacon records also key on `beaconStatus` and
 * `trackingUrl` — `ts` alone is second-precision, so a `skipped` line and a
 * later `fired`/`failed` line for the same `requestId` can share a `ts` and
 * must not be treated as the same line.
 */
function dedupeKey(record: ReconciliationRecord): string {
  if (record.kind === "beacon") {
    return `${record.kind}:${record.requestId}:${record.ts}:${record.beaconStatus}:${record.trackingUrl ?? ""}`;
  }
  return `${record.kind}:${record.requestId}:${record.ts}`;
}

/**
 * Unions the two record sets, local first, and dedupes with `dedupeKey` —
 * the same line written to both stores collapses to one entry, so
 * `foldReconciliationRecords` sees it exactly once, while distinct beacon
 * outcomes sharing a `requestId`/`ts` both survive.
 */
function mergeRecords(
  localRecords: ReconciliationRecord[],
  s3Records: ReconciliationRecord[]
): ReconciliationRecord[] {
  const deduped = new Map<string, ReconciliationRecord>();
  for (const record of [...localRecords, ...s3Records]) {
    deduped.set(dedupeKey(record), record);
  }
  return Array.from(deduped.values());
}

/**
 * Reads and folds the complete cross-container reconciliation history: the
 * local sink plus its S3 replica, unioned and deduped before folding, so
 * `GET /v1/submissions` answers from durable storage instead of one ECS
 * task's ephemeral file. Falls back to local-only rows when no bucket is
 * configured or the S3 read fails.
 */
export async function readDurableReconciliationRows(
  opts: ReadDurableReconciliationRowsOptions = {}
): Promise<ReconciliationRow[]> {
  const { sinkPath = config.telemetry.submissionsNdjsonPath, ...windowOpts } = opts;

  const [localRecords, s3Records] = await Promise.all([
    readLocalRecords(sinkPath),
    readS3Records(windowOpts),
  ]);

  return foldReconciliationRecords(mergeRecords(localRecords, s3Records));
}
