import pRetry, { AbortError } from "p-retry";

import { toErrorMessage } from "@/lib/errors";
import { getLogger } from "@/lib/logging";
import {
  CaptchaError,
  EmptyResultsError,
  ScraperError,
  SelectorFailureError,
  SessionTimeoutError,
  StepVerificationError,
  UnknownScraperError,
} from "@/scraper/errors";

const logger = getLogger({ name: "scraper/retry" });

/**
 * Tuning knobs for `withScraperRetry`. All fields are optional — callers that
 * only need the default 3-attempt policy can pass an empty object or omit the
 * argument entirely.
 */
export interface RetryOptions {
  /** Max attempts including the first try. Defaults to 3. */
  maxAttempts?: number;
  /** Called when a session needs to be torn down and re-created. */
  onSessionRestart?: () => Promise<void>;
  /** Called before each retry attempt so callers can bust caches. */
  onRetry?: (error: ScraperError, attempt: number) => void | Promise<void>;
}

/**
 * Wraps a scraper task with p-retry and a classification policy aligned
 * with our ScraperError hierarchy:
 *
 * - CaptchaError + EmptyResultsError + StepVerificationError → AbortError, no retry.
 * - SessionTimeoutError → invoke onSessionRestart before every retry, then retry up to maxAttempts.
 * - SelectorFailureError + UnknownScraperError → retry up to maxAttempts.
 * - Anything non-ScraperError → wrap in UnknownScraperError and retry.
 *
 * We lean on p-retry entirely for backoff, jitter, and attempt counting —
 * this module just supplies the policy.
 */
export async function withScraperRetry<T>(
  task: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;

  return pRetry(
    async () => {
      try {
        return await task();
      } catch (raw) {
        const err = classifyScraperError(raw);

        if (err instanceof CaptchaError) {
          // Task 10: CAPTCHA hit — log it. p-retry skips onFailedAttempt
          // for AbortError, so the warn log below is the only signal a
          // captcha was encountered before it propagates to callers.
          logger.error(`captcha encountered upstream — aborting retry: ${err.message}`);
          throw new AbortError(err.message);
        }
        if (err instanceof EmptyResultsError) {
          logger.warn(`scraper returned empty results — aborting retry: ${err.message}`);
          throw new AbortError(err.message);
        }
        if (err instanceof StepVerificationError) {
          logger.warn(
            `step verification failed deterministically — aborting retry: ${err.message}`
          );
          throw new AbortError(err.message);
        }

        if (err instanceof SessionTimeoutError && options.onSessionRestart) {
          await options.onSessionRestart();
        }

        throw err;
      }
    },
    {
      retries: Math.max(0, maxAttempts - 1),
      factor: 2,
      minTimeout: 500,
      maxTimeout: 5_000,
      randomize: true,
      onFailedAttempt: async (context) => {
        const { error, attemptNumber, retriesLeft } = context;
        logger.warn(
          `scraper attempt ${attemptNumber} failed (${error.name}): ${error.message}; ${retriesLeft} retries left`
        );
        if (options.onRetry && error instanceof ScraperError) {
          await options.onRetry(error, attemptNumber);
        }
      },
    }
  );
}

/**
 * Maps a raw thrown value (Error, string, or anything) onto our typed
 * ScraperError hierarchy so the retry policy can branch on it.
 */
export function classifyScraperError(raw: unknown): ScraperError {
  if (raw instanceof ScraperError) return raw;
  const message = toErrorMessage(raw);
  const lower = message.toLowerCase();
  if (lower.includes("captcha")) return new CaptchaError(message);
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return new SessionTimeoutError(message);
  }
  if (
    lower.includes("selector") ||
    lower.includes("could not find") ||
    lower.includes("not found")
  ) {
    return new SelectorFailureError(message);
  }
  if (lower.includes("empty") || lower.includes("no results")) {
    return new EmptyResultsError(message);
  }
  return new UnknownScraperError(message);
}
