/**
 * Pure classifier for Oracle HCM plain-text sentinel bodies. Oracle occasionally
 * responds with a raw ASCII token instead of JSON; the token's prefix determines
 * whether the failure is terminal (locked URL, must not retry) or transient
 * (rate-limit window, may retry).
 *
 * Isolated here so the discriminator logic is exhaustively testable without
 * coupling to the HTTP/p-retry machinery in http-client.ts.
 */

/** Classification of an Oracle plain-text sentinel body. */
export type OracleSentinelKind = "locked" | "transient" | "none";

/**
 * Tokens confirmed as terminal locked/rate-limit conditions. Oracle issues these
 * after repeated attempts against the same requisition URL; retrying cannot
 * succeed and may deepen the lock.
 */
const LOCKED_SENTINELS = ["ORA_URL_LOCKED"] as const;

/**
 * Classifies an Oracle HCM plain-text response body.
 *
 * Returns `'locked'` for terminal sentinels (ORA_URL_LOCKED) that must not be
 * retried. Returns `'transient'` for ORA_IRC_* tokens that represent a
 * rate-limit window and should be retried. Returns `'none'` for anything else
 * (HTML error pages, unexpected text) so the caller can fall through to its
 * existing parse-and-retry logic.
 */
export function classifyOracleSentinel(rawText: string): OracleSentinelKind {
  const trimmed = rawText.trim();

  for (const sentinel of LOCKED_SENTINELS) {
    if (trimmed === sentinel) {
      return "locked";
    }
  }

  if (trimmed.startsWith("ORA_IRC_")) {
    return "transient";
  }

  return "none";
}
