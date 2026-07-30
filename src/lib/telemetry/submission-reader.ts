/**
 * Read path for the submissions sink: parses `.barnacle/submissions.ndjson`
 * into typed reconciliation records and folds each `beacon` event onto its
 * `submit` record by `requestId`, so one row per run answers both "did we
 * submit" and "did the beacon fire" without a separate database (see
 * feat-002's `reconciliation-record.ts` for the record shapes this reads).
 *
 * The sink is `appendFile` with no locking (`submission-capture.ts`), so a
 * torn final line is expected on a live process — malformed lines are
 * skipped with a warning rather than aborting the whole read.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import {
  type BeaconEvent,
  type ReconciliationRecord,
  reconciliationRecordSchema,
  type SubmitRecord,
} from "@/lib/telemetry/reconciliation-record";

const logger = getLogger({ name: "telemetry/submission-reader" });

/**
 * One reconciliation row per run: the submit record's fields plus the
 * outcome of its beacon fire, distinct from submit status so "submitted but
 * the beacon did not fire" is measurable. `beaconStatus` defaults to
 * `"not_fired"` when no matching beacon line ever arrived. When a run has
 * both a `"skipped"` line and a real `"fired"`/`"failed"` line, the real
 * outcome wins the fold (see `foldReconciliationRecords`) regardless of
 * which line was written first. `beaconSessionIp` is the tracking-click
 * session's own outbound IP — distinct from the submit line's `session.ip`,
 * since the two are separate Browserbase sessions per run.
 */
export interface ReconciliationRow extends Omit<SubmitRecord, "kind"> {
  beaconStatus: BeaconEvent["beaconStatus"] | "not_fired";
  beaconTrackingUrl: string | null;
  beaconTs: string | null;
  beaconDurationMs: number | null;
  beaconSessionIp: string | null;
}

/** Options for `readReconciliationRows`. */
export interface ReadReconciliationRowsOptions {
  /** Override the sink path; used in tests to avoid touching the real file. */
  sinkPath?: string;
}

/**
 * Parses raw JSON, returning `undefined` on failure instead of throwing, so
 * the line-by-line reader can skip a torn/malformed line without aborting.
 */
function tryParseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * Parses NDJSON sink content into typed reconciliation records. A line that
 * is invalid JSON or fails schema validation is skipped with a warning, not
 * fatal to the read.
 */
export function parseReconciliationLines(ndjsonContent: string): ReconciliationRecord[] {
  const records: ReconciliationRecord[] = [];

  for (const rawLine of ndjsonContent.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const parsed = tryParseJson(line);
    if (parsed === undefined) {
      logger.warn(
        `skipping malformed submissions ndjson line (invalid JSON): ${line.slice(0, 200)}`
      );
      continue;
    }

    const result = reconciliationRecordSchema.safeParse(parsed);
    if (!result.success) {
      logger.warn(
        `skipping malformed submissions ndjson line (schema mismatch): ${line.slice(0, 200)}`
      );
      continue;
    }

    records.push(result.data);
  }

  return records;
}

/**
 * Rank of a beacon outcome for fold precedence: a real `fired`/`failed`
 * outcome always outranks `skipped`, because `dispatch()` writes `skipped`
 * synchronously for any self-managing plugin (`loader.ts`) before that
 * plugin's own later-recorded real outcome can arrive — write order alone
 * is not a safe proxy for which line reflects reality. Equal-rank lines
 * (e.g. a retried `fired`) fall through to array order, i.e. last one wins.
 */
function beaconRank(beaconStatus: BeaconEvent["beaconStatus"]): number {
  return beaconStatus === "skipped" ? 0 : 1;
}

/**
 * Left-joins beacon events onto submit records by `requestId`. Submit rows
 * are the base — a beacon may arrive strictly after its submit line (or
 * never), so an orphan beacon with no matching submit row is dropped rather
 * than synthesizing a phantom row. Among beacon lines for the same
 * `requestId`, the highest-`beaconRank` line wins regardless of write
 * order; ties (equal rank) fall back to a later line overwriting an
 * earlier one, so a duplicate/retry still resolves deterministically.
 */
export function foldReconciliationRecords(records: ReconciliationRecord[]): ReconciliationRow[] {
  const rows = new Map<string, ReconciliationRow>();

  for (const record of records) {
    if (record.kind !== "submit") continue;
    const { kind: _kind, ...submitFields } = record;
    rows.set(record.requestId, {
      ...submitFields,
      beaconStatus: "not_fired",
      beaconTrackingUrl: null,
      beaconTs: null,
      beaconDurationMs: null,
      beaconSessionIp: null,
    });
  }

  const winningBeacons = new Map<string, BeaconEvent>();
  for (const record of records) {
    if (record.kind !== "beacon") continue;
    const current = winningBeacons.get(record.requestId);
    if (
      current !== undefined &&
      beaconRank(current.beaconStatus) > beaconRank(record.beaconStatus)
    ) {
      continue;
    }
    winningBeacons.set(record.requestId, record);
  }

  for (const [requestId, beacon] of winningBeacons) {
    const row = rows.get(requestId);
    if (row === undefined) continue;
    rows.set(requestId, {
      ...row,
      beaconStatus: beacon.beaconStatus,
      beaconTrackingUrl: beacon.trackingUrl,
      beaconTs: beacon.ts,
      beaconDurationMs: beacon.durationMs,
      beaconSessionIp: beacon.sessionIp,
    });
  }

  return Array.from(rows.values());
}

/**
 * Reads the submissions sink and folds it into one reconciliation row per
 * run, so a plugin can join runs to its own attribution provider's report
 * without re-parsing raw NDJSON. A missing sink file (nothing submitted yet)
 * yields an empty array rather than throwing.
 */
export async function readReconciliationRows(
  opts: ReadReconciliationRowsOptions = {}
): Promise<ReconciliationRow[]> {
  const sinkPath = opts.sinkPath ?? config.telemetry.submissionsNdjsonPath;
  if (!existsSync(sinkPath)) return [];

  const content = await readFile(sinkPath, "utf8");
  return foldReconciliationRecords(parseReconciliationLines(content));
}
