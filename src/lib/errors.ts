/**
 * Shared error-coercion helpers.
 *
 * Exists to consolidate the `err instanceof Error ? err.message : String(err)`
 * ternary that was duplicated across the loader, session, server shutdown,
 * health route, and several scripts. Keeping it in one place means every
 * call site renders unknown thrown values the same way in logs and envelopes.
 */

/**
 * Normalises an `unknown` thrown value to a string suitable for logging or
 * error messages. Real `Error` instances surface their `.message`; everything
 * else falls back to `String(value)`.
 */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
