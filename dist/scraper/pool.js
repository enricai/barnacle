"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWithSession = runWithSession;
exports.poolStats = poolStats;
exports.drainPool = drainPool;
const p_queue_1 = __importDefault(require("p-queue"));
const config_1 = require("../config");
const logging_1 = require("../lib/logging");
const errors_1 = require("../scraper/errors");
const retry_1 = require("../scraper/retry");
const session_1 = require("../scraper/session");
const logger = (0, logging_1.getLogger)({ name: "scraper/pool" });
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
 * task, not pre-warmed, so Steel billing stays proportional to actual
 * traffic.
 */
const queue = new p_queue_1.default({ concurrency: config_1.config.scraper.poolSize });
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
async function runWithSession(task, retryOptions = {}, taskTimeoutMs = TASK_TIMEOUT_MS, sessionOpts = {}) {
    return queue.add(async () => {
        const sessionRef = { session: null };
        const ensureSession = async () => {
            if (!sessionRef.session) {
                sessionRef.session = await (0, session_1.createBrowserSession)(sessionOpts);
            }
            return sessionRef.session;
        };
        const closeSession = async () => {
            if (sessionRef.session) {
                await sessionRef.session.close();
                sessionRef.session = null;
            }
        };
        try {
            return await (0, retry_1.withScraperRetry)(async () => {
                const session = await ensureSession();
                const timeout = new Promise((_, reject) => {
                    const t = setTimeout(() => reject(new errors_1.SessionTimeoutError(`task exceeded ${taskTimeoutMs}ms`)), taskTimeoutMs);
                    t.unref();
                });
                return Promise.race([task(session), timeout]);
            }, {
                ...retryOptions,
                onSessionRestart: async () => {
                    logger.info("restarting scraper session after timeout");
                    await closeSession();
                },
            });
        }
        finally {
            await closeSession();
        }
    });
}
/**
 * Exposed for tests and health probes. Returns the current number of
 * queued + in-flight scraper tasks so /readyz can surface back-pressure.
 */
function poolStats() {
    return {
        size: queue.size,
        pending: queue.pending,
        concurrency: queue.concurrency,
    };
}
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
async function drainPool(timeoutMs = 20_000) {
    queue.pause();
    const onIdle = queue.onIdle();
    await Promise.race([onIdle, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    queue.clear();
}
//# sourceMappingURL=pool.js.map