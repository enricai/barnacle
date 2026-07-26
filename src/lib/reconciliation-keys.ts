/**
 * Site-agnostic Appcast reconciliation join keys, derived once here so every
 * downstream writer (submission envelope, beacon-fire record) records the
 * same `vivclid` and job reference instead of each caller re-deriving them
 * from a differently-shaped plugin payload.
 */

export interface ReconciliationKeys {
  vivclid: string | null;
  jobReference: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lookupCaseInsensitive(payload: Record<string, unknown>, key: string): unknown {
  const lower = key.toLowerCase();
  for (const k of Object.keys(payload)) {
    if (k.toLowerCase() === lower) return payload[k];
  }
  return undefined;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Parses a plugin's `TrackingUrl` into its query params, tolerating whatever
 * garbage an inbound payload throws at it — a malformed or absent URL is a
 * missing join key, not a crash.
 */
function trackingUrlParams(payload: Record<string, unknown>): URLSearchParams | null {
  const trackingUrl = asNonEmptyString(lookupCaseInsensitive(payload, "TrackingUrl"));
  if (!trackingUrl) return null;
  try {
    return new URL(trackingUrl).searchParams;
  } catch {
    return null;
  }
}

/**
 * Resolves the Appcast `vivclid` join key: an explicit top-level payload
 * field first (case-insensitive, since plugins disagree on casing), falling
 * back to the same-named query param on `TrackingUrl`.
 */
export function extractVivclid(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  const direct = asNonEmptyString(lookupCaseInsensitive(payload, "vivclid"));
  if (direct) return direct;

  const params = trackingUrlParams(payload);
  return params ? asNonEmptyString(params.get("vivclid")) : null;
}

/**
 * Resolves the Appcast job-reference join key (`<empId>_<jid>`), preferring
 * an explicit `jobReference` field over composing one from `empId`/`jid`
 * pairs, and preferring payload fields over the same pair carried in
 * `TrackingUrl`'s query string.
 */
export function extractJobReference(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  const explicit = asNonEmptyString(lookupCaseInsensitive(payload, "jobReference"));
  if (explicit) return explicit;

  const empId = asNonEmptyString(lookupCaseInsensitive(payload, "empId"));
  const jid = asNonEmptyString(lookupCaseInsensitive(payload, "jid"));
  if (empId && jid) return `${empId}_${jid}`;

  const params = trackingUrlParams(payload);
  const urlEmpId = params ? asNonEmptyString(params.get("empId")) : null;
  const urlJid = params ? asNonEmptyString(params.get("jid")) : null;
  return urlEmpId && urlJid ? `${urlEmpId}_${urlJid}` : null;
}

/**
 * Derives both Appcast reconciliation join keys from an inbound plugin
 * payload in one call — the single place every submission/beacon writer
 * should read `vivclid` and the job reference from.
 */
export function extractReconciliationKeys(payload: unknown): ReconciliationKeys {
  return {
    vivclid: extractVivclid(payload),
    jobReference: extractJobReference(payload),
  };
}
