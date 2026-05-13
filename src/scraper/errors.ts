/**
 * Error hierarchy produced by the scraper. These are internal — they stay
 * inside the scraper + service layer and are translated into API envelope
 * errors (via src/api/errors.ts) before they reach the client.
 *
 * Why: each class encodes a distinct recovery policy that p-retry and the
 * session pool key off of. CaptchaError aborts the whole call (the scraper
 * can't self-resolve one — Steel handles it upstream, and if we still see
 * a captcha downstream there's nothing a retry can do). EmptyResultsError
 * is "success but no data" and also aborts. SelectorFailureError is the
 * most common — the target page UI drifted, Stagehand's action cache got stale —
 * and a fresh AI-resolution retry usually fixes it. SessionTimeoutError
 * needs a brand-new session, so retry.ts invokes its onRestart callback
 * before the next attempt.
 */

/**
 * Base class for all scraper-internal errors. Each subclass encodes a
 * distinct recovery policy (retryable or not) that retry.ts and loader.ts
 * key off of to decide whether to retry, restart the session, or abort.
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
 * behalf. Propagate upstream as error code 2004.
 */
export class CaptchaError extends ScraperError {
  constructor(message = "captcha challenge encountered") {
    super(message, false);
  }
}

/**
 * The scrape completed but returned no data. This is not a failure — it's
 * a legitimate empty result (e.g. a search returned zero matches). The
 * service layer handles this without throwing.
 */
export class EmptyResultsError extends ScraperError {
  constructor(message = "scrape returned no results") {
    super(message, false);
  }
}

/**
 * Stagehand failed to resolve a selector or an `act()` call. The most
 * likely cause is that the cached action hash is stale because the target
 * page's UI changed. Retries bust the cache and fall back to fresh AI inference.
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

/**
 * Recon-only: a flow step in recon-browser.ts exhausted its self-healing
 * retry cascade without producing an observable effect (no network call,
 * no URL change). Non-retryable — the recon-browser loop itself owns the
 * four-attempt cascade, so by the time this throws the human needs to
 * edit the flow text. The runtime path never sees this.
 */
export class StepVerificationError extends ScraperError {
  constructor(message = "recon step failed verification after all heal attempts") {
    super(message, false);
  }
}

/**
 * The direct-HTTP hot path received a response that did not match the plugin's
 * Zod response schema. Non-retryable on the hot path — the dispatch layer uses
 * this as the trigger to fall back to the Stagehand browser path instead.
 */
export class HttpSchemaError extends ScraperError {
  constructor(message = "http response schema mismatch") {
    super(message, false);
  }
}

/**
 * The direct-HTTP hot path received a non-2xx response that signals a bot
 * challenge or auth wall (403, 401). Non-retryable — fall back to Stagehand.
 */
export class HttpBotChallengeError extends ScraperError {
  constructor(message = "http bot challenge or auth required") {
    super(message, false);
  }
}

/**
 * The direct-HTTP hot path received a 5xx server error. Non-retryable on the
 * hot path — dispatch uses this as a fallback trigger just like HttpSchemaError.
 * Kept distinct from HttpBotChallengeError so metrics and logs can tell apart
 * a target server outage from a bot-detection block.
 */
export class HttpServerError extends ScraperError {
  constructor(message = "http 5xx server error") {
    super(message, false);
  }
}

/**
 * The direct-HTTP hot path received a 429 rate-limit response. Non-retryable
 * and NOT a fallback trigger — a 429 means the configured rps ceiling is too
 * high; the right response is to back off and surface the metric, not burn a
 * Steel browser session.
 */
export class HttpRateLimitError extends ScraperError {
  constructor(message = "http 429 rate limit exceeded") {
    super(message, false);
  }
}
