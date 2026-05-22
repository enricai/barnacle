import Bottleneck from "bottleneck";

import { config } from "@/config";
import { randomIntInclusive } from "@/lib/random";

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
export function createSessionLimiter(): Bottleneck {
  return new Bottleneck({
    maxConcurrent: 1,
    minTime: config.scraper.minActionDelayMs,
  });
}

/**
 * Schedules a scraper action through the limiter with an additional jitter
 * window so consecutive calls don't look metronomic. Returns the awaited
 * result of `fn`.
 */
export async function scheduleAction<T>(limiter: Bottleneck, fn: () => Promise<T>): Promise<T> {
  const jitter = randomIntInclusive(
    0,
    config.scraper.maxActionDelayMs - config.scraper.minActionDelayMs - 1
  );
  return limiter.schedule({ weight: 1, priority: 5 }, async () => {
    if (jitter > 0) await sleep(jitter);
    return fn();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
