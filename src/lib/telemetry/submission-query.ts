/**
 * Predicate composition over `ReconciliationRow[]` (feat-007's reader
 * output), so a caller can ask reconciliation-shaped questions — rows for a
 * given `siteId` cohort, `requestId`, submit outcome, beacon status, or date
 * window — without re-parsing the submissions NDJSON. Pure and I/O-free: the
 * route layer composes `readDurableReconciliationRows`
 * (`src/lib/telemetry/reconciliation-source.ts`) then this module.
 */

import { compareDesc, isAfter, isBefore, parseISO } from "date-fns";

import type { SubmitRecord } from "@/lib/telemetry/reconciliation-record";
import type { ReconciliationRow } from "@/lib/telemetry/submission-reader";

/**
 * Filters for `queryReconciliationRows`. Every field is optional; the
 * fields present are combined with AND. `from`/`to` bound the `ts` window
 * inclusively; `limit`/`offset` paginate the newest-first result.
 */
export interface ReconciliationRowFilter {
  siteId?: string;
  requestId?: string;
  status?: SubmitRecord["status"];
  beaconStatus?: ReconciliationRow["beaconStatus"];
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

type ReconciliationRowPredicate = (row: ReconciliationRow) => boolean;

/**
 * Builds the AND-composed predicate list for the filter fields actually
 * present, so an absent field never excludes a row. `from`/`to` are
 * inclusive bounds expressed via `isBefore`/`isAfter` negation rather than
 * `isWithinInterval`, since either bound may be supplied without the other.
 */
function buildPredicates(filter: ReconciliationRowFilter): ReconciliationRowPredicate[] {
  const { siteId, requestId, status, beaconStatus, from, to } = filter;

  return [
    siteId === undefined ? null : (row: ReconciliationRow) => row.siteId === siteId,
    requestId === undefined ? null : (row: ReconciliationRow) => row.requestId === requestId,
    status === undefined ? null : (row: ReconciliationRow) => row.status === status,
    beaconStatus === undefined
      ? null
      : (row: ReconciliationRow) => row.beaconStatus === beaconStatus,
    from === undefined
      ? null
      : (row: ReconciliationRow) => !isBefore(parseISO(row.ts), parseISO(from)),
    to === undefined ? null : (row: ReconciliationRow) => !isAfter(parseISO(row.ts), parseISO(to)),
  ].filter((predicate): predicate is ReconciliationRowPredicate => predicate !== null);
}

/**
 * Filters, sorts (newest-first by `ts`), and paginates reconciliation rows
 * so the attribution-report join a human pulls in pages is deterministic
 * rather than relying on the sink's append order.
 */
export function queryReconciliationRows(
  rows: ReconciliationRow[],
  filter: ReconciliationRowFilter = {}
): ReconciliationRow[] {
  const predicates = buildPredicates(filter);
  const matched =
    predicates.length === 0
      ? rows
      : rows.filter((row) => predicates.every((predicate) => predicate(row)));
  const sorted = [...matched].sort((a, b) => compareDesc(parseISO(a.ts), parseISO(b.ts)));

  const offset = filter.offset ?? 0;
  const limit = filter.limit ?? sorted.length;
  return sorted.slice(offset, offset + limit);
}
