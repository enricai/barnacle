/**
 * Durable read path for reconciliation rows: unions the container-local
 * submissions sink with the S3-mirrored objects (feat-003's
 * `listSubmissionsS3Objects` + `fetchSubmissionsS3Records`) before folding,
 * so a submit line written by one ECS task and its beacon line written by
 * another both land in the same row instead of two ephemeral, incomplete
 * ones. Merge happens at the record level — before
 * `foldReconciliationRecords` — because folding first would discard the
 * beacon detail a cross-store fold still needs (see
 * `submission-reader.ts`'s `foldReconciliationRecords`).
 *
 * The local sink and its S3 mirror both receive the exact same line for
 * every event (`appendSubmissionSinkLine` writes to disk and buffers to S3
 * in the same call), so an overlap between the two stores is an exact JSON
 * duplicate, never a conflicting value — deduping on full record content is
 * therefore lossless.
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
 * Lists and fetches the S3-mirrored records for the window. A rejection
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
 * Dedupe key for a raw record: the full record content, so only an exact
 * JSON duplicate (the same line mirrored to both stores) collapses to one
 * entry. `ts` alone (`formatISO`'s output has no millisecond component —
 * `beacon-capture.ts`/`submission-capture.ts`) is not enough to key on: a
 * plugin-recorded `fired` beacon and `dispatch()`'s automatic `skipped`
 * beacon for the same `requestId` routinely land in the same wall-clock
 * second, so `kind:requestId:ts` would collide two genuinely different
 * events and let `foldReconciliationRecords`'s precedence never see the
 * dropped one.
 */
function dedupeKey(record: ReconciliationRecord): string {
  return JSON.stringify(record);
}

/**
 * Unions the two record sets, local first, and dedupes on exact record
 * content — the same line written to both stores collapses to one entry, so
 * `foldReconciliationRecords` sees it exactly once.
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
 * local sink plus its S3 mirror, unioned and deduped before folding, so
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
