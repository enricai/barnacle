import { ScraperError } from "../scraper/errors";
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
 * - CaptchaError + EmptyResultsError → AbortError, no retry.
 * - SessionTimeoutError → invoke onSessionRestart once (guarded by sessionRestartEntry.done), then retry up to maxAttempts.
 * - SelectorFailureError + UnknownScraperError → retry up to maxAttempts.
 * - Anything non-ScraperError → wrap in UnknownScraperError and retry.
 *
 * We lean on p-retry entirely for backoff, jitter, and attempt counting —
 * this module just supplies the policy.
 */
export declare function withScraperRetry<T>(task: () => Promise<T>, options?: RetryOptions): Promise<T>;
/**
 * Maps a raw thrown value (Error, string, or anything) onto our typed
 * ScraperError hierarchy so the retry policy can branch on it.
 */
export declare function classifyScraperError(raw: unknown): ScraperError;
