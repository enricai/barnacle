import { type RetryOptions } from "../scraper/retry";
import { type BrowserSession } from "../scraper/session";
/**
 * Runs `task` inside a freshly created browser session. The session is
 * torn down in a `finally` block even if `task` throws. Retries are
 * supplied by `withScraperRetry` — `SessionTimeoutError` causes a session
 * tear-down and fresh re-creation for the next attempt.
 *
 * Each queued task is bounded by `TASK_TIMEOUT_MS`. A hung Stagehand
 * operation would otherwise block the queue slot indefinitely; the timeout
 * converts the hang into a `SessionTimeoutError` so the retry policy can
 * restart the session and try again.
 */
export declare function runWithSession<T>(task: (session: BrowserSession) => Promise<T>, retryOptions?: Omit<RetryOptions, "onSessionRestart">, taskTimeoutMs?: number, sessionOpts?: {
    advancedStealth?: boolean;
}): Promise<T>;
/**
 * Exposed for tests and health probes. Returns the current number of
 * queued + in-flight scraper tasks so /readyz can surface back-pressure.
 */
export declare function poolStats(): {
    size: number;
    pending: number;
    concurrency: number;
};
/**
 * Drains the scraper queue on graceful shutdown — pauses new intake,
 * waits for in-flight tasks' `finally` blocks to close their Steel
 * sessions, then resolves. Leaving sessions open past process exit
 * means Steel keeps billing until their own timeout kicks in.
 *
 * Bounded by `timeoutMs` so a hung scrape can't block SIGTERM forever;
 * the orchestrator's grace period is usually 30s, so 20s is a safe
 * default that leaves headroom for Fastify to flush.
 */
export declare function drainPool(timeoutMs?: number): Promise<void>;
