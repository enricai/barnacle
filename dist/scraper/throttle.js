"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSessionLimiter = createSessionLimiter;
exports.scheduleAction = scheduleAction;
const bottleneck_1 = __importDefault(require("bottleneck"));
const config_1 = require("../config");
const random_1 = require("../lib/random");
/**
 * Creates a Bottleneck limiter scoped to a single scraper session.
 *
 * Why Bottleneck: battle-tested (used by GitHub's Octokit), handles min-
 * time-between-jobs, max-concurrent, and graceful drain. We don't invent
 * any delay logic on top — every `stagehand.act()` or `stagehand.extract()` goes
 * through `limiter.schedule(() => stagehand.act(...))` and Bottleneck enforces
 * the cadence.
 *
 * How to apply: the pool grabs one limiter per session; concurrency
 * across sessions is managed by the outer p-queue in pool.ts.
 */
function createSessionLimiter() {
    return new bottleneck_1.default({
        maxConcurrent: 1,
        minTime: config_1.config.scraper.minActionDelayMs,
    });
}
/**
 * Schedules a scraper action through the limiter with an additional jitter
 * window so consecutive calls don't look metronomic. Returns the awaited
 * result of `fn`.
 */
async function scheduleAction(limiter, fn) {
    const jitter = (0, random_1.randomIntInclusive)(0, config_1.config.scraper.maxActionDelayMs - config_1.config.scraper.minActionDelayMs - 1);
    return limiter.schedule({ weight: 1, priority: 5 }, async () => {
        if (jitter > 0)
            await sleep(jitter);
        return fn();
    });
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=throttle.js.map