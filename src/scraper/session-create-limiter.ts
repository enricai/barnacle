import Bottleneck from "bottleneck";
import pRetry, { AbortError } from "p-retry";

import { config } from "@/config";
import {
  BrowserbaseSessionCreateRateLimitError,
  isBrowserbaseSessionCreateRateLimitError,
} from "@/scraper/errors";

/**
 * Process-wide (not per-session) Bottleneck limiter pacing session-create
 * calls. Distinct from throttle.ts's `createSessionLimiter`, which paces
 * post-creation actions on an already-created session — this limiter gates
 * the create call itself so a restart surge across the whole pool can't
 * fire every session-create attempt at once.
 */
const sessionCreateLimiter = new Bottleneck({
  maxConcurrent: config.scraper.sessionCreateMaxConcurrent,
  minTime: config.scraper.sessionCreateMinIntervalMs,
});

/**
 * Schedules `fn` (typically `stagehand.init()`) through the process-wide
 * session-create limiter, retrying with exponential backoff when the
 * provider rejects the create call with a 429. Any other failure from `fn`
 * propagates unmodified once the retry budget is exhausted.
 */
export async function scheduleSessionCreate<T>(fn: () => Promise<T>): Promise<T> {
  return pRetry(
    () =>
      sessionCreateLimiter.schedule(async () => {
        try {
          return await fn();
        } catch (raw) {
          if (isBrowserbaseSessionCreateRateLimitError(raw)) {
            throw new BrowserbaseSessionCreateRateLimitError(
              raw instanceof Error ? raw.message : undefined
            );
          }
          throw new AbortError(raw instanceof Error ? raw : new Error(String(raw)));
        }
      }),
    {
      retries: Math.max(0, config.scraper.sessionCreateMaxRetries - 1),
      factor: 2,
      minTimeout: 500,
      maxTimeout: 5_000,
      randomize: true,
    }
  );
}
