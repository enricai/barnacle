/**
 * Error hierarchy produced by the scraper. These are internal — they stay
 * inside the scraper + service layer and are translated into VPS envelope
 * errors (via src/api/errors.ts) before they reach the client.
 *
 * Why: each class encodes a distinct recovery policy that p-retry and the
 * session pool key off of. CaptchaError aborts the whole call (the scraper
 * can't self-resolve one — Steel handles it upstream, and if we still see
 * a captcha downstream there's nothing a retry can do). EmptyResultsError
 * is "success but no data" and also aborts. SelectorFailureError is the
 * most common — the form UI drifted, Stagehand's action cache got stale —
 * and a fresh AI-resolution retry usually fixes it. SessionTimeoutError
 * needs a brand-new session, so retry.ts invokes its onRestart callback
 * before the next attempt.
 */

export abstract class ScraperError extends Error {
  public readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = new.target.name;
    this.retryable = retryable;
  }
}

/**
 * The scraper encountered a CAPTCHA challenge Steel couldn't solve on our
 * behalf. Propagate upstream as VPS code 2004.
 */
export class CaptchaError extends ScraperError {
  constructor(message = "captcha challenge encountered") {
    super(message, false);
  }
}

/**
 * The scrape completed but returned no data. This is not a failure — it's
 * a legitimate empty result (e.g. the form completed with no confirmation
 * number extracted). The service layer handles this without throwing.
 */
export class EmptyResultsError extends ScraperError {
  constructor(message = "scrape returned no results") {
    super(message, false);
  }
}

/**
 * Stagehand failed to resolve a selector or an `act()` call. The most
 * likely cause is that the cached action hash is stale because the form's
 * UI changed. Retries bust the cache and fall back to fresh AI inference.
 */
export class SelectorFailureError extends ScraperError {
  constructor(message = "scraper selector failure") {
    super(message, true);
  }
}

/**
 * The upstream Steel browser session timed out or closed unexpectedly.
 * Needs a fresh session to retry — the session pool wrapper in retry.ts
 * honors this by invoking its `onRestart` hook before re-running.
 */
export class SessionTimeoutError extends ScraperError {
  constructor(message = "scraper session timed out") {
    super(message, true);
  }
}

/**
 * Catch-all for unclassified scraper failures. Retryable by default so
 * transient issues (DOM not settled, network blips) get a second chance.
 */
export class UnknownScraperError extends ScraperError {
  constructor(message = "unknown scraper failure") {
    super(message, true);
  }
}
