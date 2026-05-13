import PQueue from "p-queue";

import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import { type RetryOptions, withScraperRetry } from "@/scraper/retry";
import { type BrowserSession, createBrowserSession } from "@/scraper/session";

const logger = getLogger({ name: "scraper/pool" });

/**
 * Shared queue that limits how many scraper tasks run concurrently across
 * the whole process. Sessions are created on demand inside each queued
 * task, not pre-warmed, so Steel billing stays proportional to actual
 * traffic.
 */
const queue = new PQueue({ concurrency: config.scraper.poolSize });

/**
 * Runs `task` inside a freshly created browser session. The session is
 * torn down in a `finally` block even if `task` throws. Retries are
 * supplied by `withScraperRetry` — `SessionTimeoutError` causes a session
 * tear-down and fresh re-creation for the next attempt.
 */
export async function runWithSession<T>(
  task: (session: BrowserSession) => Promise<T>,
  retryOptions: Omit<RetryOptions, "onSessionRestart"> = {}
): Promise<T> {
  return queue.add(
    async () => {
      const sessionRef: { session: BrowserSession | null } = { session: null };

      const ensureSession = async (): Promise<BrowserSession> => {
        if (!sessionRef.session) {
          sessionRef.session = await createBrowserSession();
        }
        return sessionRef.session;
      };

      const closeSession = async (): Promise<void> => {
        if (sessionRef.session) {
          await sessionRef.session.close();
          sessionRef.session = null;
        }
      };

      try {
        return await withScraperRetry(
          async () => {
            const session = await ensureSession();
            return task(session);
          },
          {
            ...retryOptions,
            onSessionRestart: async () => {
              logger.info("restarting scraper session after timeout");
              await closeSession();
            },
          }
        );
      } finally {
        await closeSession();
      }
    },
    { throwOnTimeout: true }
  ) as Promise<T>;
}

/**
 * Exposed for tests and health probes. Returns the current number of
 * queued + in-flight scraper tasks so /readyz can surface back-pressure.
 */
export function poolStats(): { size: number; pending: number; concurrency: number } {
  return {
    size: queue.size,
    pending: queue.pending,
    concurrency: queue.concurrency,
  };
}
