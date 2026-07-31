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

/**
 * True when `err` is Node's "module is absent" resolution failure, as opposed to
 * a module that exists but threw while loading. Optional peer dependencies need
 * the distinction: a missing package earns a friendly "install it" hint, while
 * any other failure must surface its own message instead of being reported as
 * uninstalled.
 */
export function isModuleNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "MODULE_NOT_FOUND";
}
