/**
 * Generic retrying browser-session runner. Acquires a fresh session from
 * `sessionFactory`, runs `callback(session)`, guarantees `session.close()` in
 * every code path, and retries up to `retryOptions.retries + 1` attempts with
 * the caller-supplied pRetry options. On exhaustion, wraps the last error in
 * the caller-supplied `exhaustionError`.
 *
 * Extracted from appcast/tokens/warmup.ts so any future recon→generate warmup
 * flow can reuse the session-lifecycle shell without re-hand-rolling pRetry +
 * finally-close + error-mapping each time.
 */

import pRetry, { type Options as PRetryOptions } from "p-retry";

import { toErrorMessage } from "@/lib/errors";
import { getLogger } from "@/lib/logging";
import type { BrowserSession } from "@/scraper/session-shared";

const logger = getLogger({ name: "scraper/session-warmup" });

export interface SessionWarmupOptions {
  /** pRetry options forwarded verbatim. The caller controls retries, timeouts, and onFailedAttempt. */
  retryOptions: PRetryOptions;
  /**
   * Invoked with the last-thrown error when all attempts are exhausted. Return
   * the error that `withBrowserSession` should throw (typically a domain-specific
   * error type the caller's dispatch layer understands).
   */
  mapExhaustionError: (err: unknown) => Error;
}

/**
 * Runs `callback` inside a fresh browser session on every attempt. Guarantees
 * that `session.close()` is called regardless of whether the callback succeeds
 * or throws. On exhaustion, calls `opts.mapExhaustionError` with the last pRetry
 * error and throws whatever it returns.
 */
export async function withBrowserSession<T>(
  sessionFactory: () => Promise<BrowserSession>,
  callback: (session: BrowserSession, attemptNumber: number) => Promise<T>,
  opts: SessionWarmupOptions
): Promise<T> {
  try {
    return await pRetry(async (attemptNumber) => {
      const session = await sessionFactory();
      try {
        return await callback(session, attemptNumber);
      } finally {
        await session.close().catch((closeErr) => {
          logger.warn(
            `session-warmup: close failed for ${session.sessionId}: ${toErrorMessage(closeErr)}`
          );
        });
      }
    }, opts.retryOptions);
  } catch (err) {
    throw opts.mapExhaustionError(err);
  }
}
