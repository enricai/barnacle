/**
 * VPS sail-date utilities.
 *
 * RC (and VPS) uses `YYYY-MM-DD` strings to identify a calendar day,
 * not an instant. When persisting to Postgres we need a concrete
 * `Date`, and the TZ we anchor to matters: `parseISO("2025-06-20")`
 * from date-fns returns the LOCAL midnight, which round-trips
 * incorrectly through `toISOString().slice(0, 10)` on servers east of
 * UTC. Anchoring to UTC midnight keeps writes and reads stable across
 * any process timezone.
 */

/**
 * Converts a `YYYY-MM-DD` sail-date string to a `Date` at UTC midnight.
 * Caller must have validated the input shape (e.g. via
 * `sailDateStringSchema`) — this doesn't re-validate.
 */
export function parseSailDateUtc(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

/**
 * Converts a stored sail-date `Date` into RC's numeric `YYYYMMDD`
 * form used by the delta endpoints. Pairs with `parseSailDateUtc`
 * on the write side — round-trip stable across any process TZ.
 */
export function sailDateToNumeric(d: Date): number {
  return Number.parseInt(d.toISOString().slice(0, 10).replace(/-/g, ""), 10);
}
