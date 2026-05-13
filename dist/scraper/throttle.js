"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSessionLimiter = createSessionLimiter;
exports.scheduleAction = scheduleAction;
exports.randomViewport = randomViewport;
const bottleneck_1 = __importDefault(require("bottleneck"));
const config_1 = require("@/config");
/**
 * Creates a Bottleneck limiter scoped to a single scraper session.
 *
 * Why Bottleneck: battle-tested (used by GitHub's Octokit), handles min-
 * time-between-jobs, max-concurrent, and graceful drain. We don't invent
 * any delay logic on top — every `page.act()` or `page.extract()` goes
 * through `limiter.schedule(() => page.act(...))` and Bottleneck enforces
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
    const jitter = randomIntInRange(0, config_1.config.scraper.maxActionDelayMs - config_1.config.scraper.minActionDelayMs);
    return limiter.schedule({ weight: 1, priority: 5 }, async () => {
        if (jitter > 0)
            await sleep(jitter);
        return fn();
    });
}
/**
 * Returns a plausible desktop viewport so session fingerprints don't all
 * match exactly. RC cares about these signals — random but sane values
 * keep us looking like a varied user base.
 */
function randomViewport() {
    const widths = [1280, 1366, 1440, 1536, 1600, 1680, 1920];
    const heights = [720, 768, 800, 900, 1050, 1080];
    const width = widths[Math.floor(Math.random() * widths.length)] ?? 1440;
    const height = heights[Math.floor(Math.random() * heights.length)] ?? 900;
    return { width, height };
}
function randomIntInRange(min, max) {
    if (max <= min)
        return min;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=throttle.js.map