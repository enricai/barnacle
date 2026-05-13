"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWithSession = runWithSession;
exports.poolStats = poolStats;
const p_queue_1 = __importDefault(require("p-queue"));
const config_1 = require("@/config");
const logging_1 = require("@/lib/logging");
const retry_1 = require("@/scraper/retry");
const session_1 = require("@/scraper/session");
const logger = (0, logging_1.getLogger)({ name: "scraper/pool" });
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
 */
async function runWithSession(task, retryOptions = {}) {
    return queue.add(async () => {
        const sessionRef = { session: null };
        const ensureSession = async () => {
            if (!sessionRef.session) {
                sessionRef.session = await (0, session_1.createBrowserSession)();
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
                return task(session);
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
    }, { throwOnTimeout: true });
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
//# sourceMappingURL=pool.js.map