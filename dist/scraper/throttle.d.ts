import Bottleneck from "bottleneck";
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
export declare function createSessionLimiter(): Bottleneck;
/**
 * Schedules a scraper action through the limiter with an additional jitter
 * window so consecutive calls don't look metronomic. Returns the awaited
 * result of `fn`.
 */
export declare function scheduleAction<T>(limiter: Bottleneck, fn: () => Promise<T>): Promise<T>;
