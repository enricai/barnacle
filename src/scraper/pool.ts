import PQueue from "p-queue";

import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import { TaskDeadlineError } from "@/scraper/errors";
import { type RetryOptions, withScraperRetry } from "@/scraper/retry";
import { type BrowserSession, createBrowserSession } from "@/scraper/session";
import type { BrowserSessionOptions } from "@/scraper/session-shared";
import { resolveSessionDeathError } from "@/scraper/session-teardown";

/** How long a task may take to settle after its signal is aborted before we give up on it. */
const TASK_STOP_GRACE_MS = 30_000;

/** Second argument handed to every task: aborted with TaskDeadlineError at the deadline. */
export interface TaskContext {
  signal: AbortSignal;
  /** Absolute deadline, epoch ms. */
  deadlineAt: number;
}

const logger = getLogger({ name: "scraper/pool" });

/**
 * Per-task hard timeout default. A hung Stagehand operation (infinite network wait,
 * frozen CDP connection) would otherwise block the queue slot indefinitely,
 * draining pool capacity without recovery. This ceiling converts a silent
 * hang into a SessionTimeoutError that the retry policy can act on.
 * Individual plugins may override this via SitePluginMeta.taskTimeoutMs.
 */
const TASK_TIMEOUT_MS = 60 * 60 * 1_000; // 60 minutes

/**
 * Shared queue that limits how many scraper tasks run concurrently across
 * the whole process. Sessions are created on demand inside each queued
 * task, not pre-warmed, so provider billing (Browserbase by default, Steel
 * for the opt-in fallback) stays proportional to actual traffic.
 */
const queue = new PQueue({ concurrency: config.scraper.poolSize });

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
export async function runWithSession<T>(
  task: (session: BrowserSession, ctx: TaskContext) => Promise<T>,
  retryOptions: Omit<RetryOptions, "onSessionRestart"> = {},
  taskTimeoutMs = TASK_TIMEOUT_MS,
  sessionOpts: Omit<BrowserSessionOptions, "provider"> = {},
  stopGraceMs = TASK_STOP_GRACE_MS
): Promise<T> {
  return queue.add(async () => {
    const sessionRef: { session: BrowserSession | null } = { session: null };

    const ensureSession = async (): Promise<BrowserSession> => {
      if (!sessionRef.session) {
        sessionRef.session = await createBrowserSession(sessionOpts);
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
          const controller = new AbortController();
          const deadlineAt = Date.now() + taskTimeoutMs;
          let timer: NodeJS.Timeout | undefined;
          let graceTimer: NodeJS.Timeout | undefined;
          let deadlineHit = false;
          const taskPromise = Promise.resolve().then(() =>
            task(session, { signal: controller.signal, deadlineAt })
          );
          const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              deadlineHit = true;
              const err = new TaskDeadlineError(`task exceeded ${taskTimeoutMs}ms`);
              controller.abort(err);
              // Reject only once the task has stopped, so the session is not
              // closed and no retry begins while it still runs. If it never
              // stops, give up after the grace period (outcome unknown).
              const giveUp = (): void => reject(err);
              taskPromise.then(giveUp, giveUp);
              graceTimer = setTimeout(giveUp, stopGraceMs);
              graceTimer.unref();
            }, taskTimeoutMs);
            timer.unref();
          });
          deadline.catch(() => {});
          try {
            return await Promise.race([taskPromise, deadline]);
          } catch (err) {
            if (deadlineHit) throw new TaskDeadlineError(`task exceeded ${taskTimeoutMs}ms`);
            // Must run before onSessionRestart: closeSession() nulls sessionRef.
            throw resolveSessionDeathError(sessionRef.session ?? undefined, err);
          } finally {
            clearTimeout(timer);
            clearTimeout(graceTimer);
          }
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
  }) as Promise<T>;
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

/**
 * Drains the scraper queue on graceful shutdown — pauses new intake,
 * waits for in-flight tasks' `finally` blocks to close their sessions,
 * then resolves. Leaving sessions open past process exit means the
 * provider keeps billing until their own timeout kicks in.
 *
 * Bounded by `timeoutMs` so a hung scrape can't block SIGTERM forever;
 * the orchestrator's grace period is usually 30s, so 20s is a safe
 * default that leaves headroom for Fastify to flush.
 */
export async function drainPool(timeoutMs = 20_000): Promise<void> {
  queue.pause();
  const onIdle = queue.onIdle();
  await Promise.race([onIdle, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  queue.clear();
}
