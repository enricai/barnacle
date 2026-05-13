"use strict";
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
 * most common — the RC UI drifted, Stagehand's action cache got stale —
 * and a fresh AI-resolution retry usually fixes it. SessionTimeoutError
 * needs a brand-new session, so retry.ts invokes its onRestart callback
 * before the next attempt.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnknownScraperError = exports.SessionTimeoutError = exports.SelectorFailureError = exports.EmptyResultsError = exports.CaptchaError = exports.ScraperError = void 0;
class ScraperError extends Error {
    retryable;
    constructor(message, retryable) {
        super(message);
        this.name = new.target.name;
        this.retryable = retryable;
    }
}
exports.ScraperError = ScraperError;
/**
 * The scraper encountered a CAPTCHA challenge Steel couldn't solve on our
 * behalf. Propagate upstream as VPS code 2004.
 */
class CaptchaError extends ScraperError {
    constructor(message = "captcha challenge encountered") {
        super(message, false);
    }
}
exports.CaptchaError = CaptchaError;
/**
 * The scrape completed but returned no data. This is not a failure — it's
 * a legitimate empty result (e.g. no sailings match the filters). The
 * service layer converts this into an empty-array response with VPS status
 * OK, not an error.
 */
class EmptyResultsError extends ScraperError {
    constructor(message = "scrape returned no results") {
        super(message, false);
    }
}
exports.EmptyResultsError = EmptyResultsError;
/**
 * Stagehand failed to resolve a selector or an `act()` call. The most
 * likely cause is that the cached action hash is stale because RC shipped
 * UI changes. Retries bust the cache and fall back to fresh AI inference.
 */
class SelectorFailureError extends ScraperError {
    constructor(message = "scraper selector failure") {
        super(message, true);
    }
}
exports.SelectorFailureError = SelectorFailureError;
/**
 * The upstream Steel browser session timed out or closed unexpectedly.
 * Needs a fresh session to retry — the session pool wrapper in retry.ts
 * honors this by invoking its `onRestart` hook before re-running.
 */
class SessionTimeoutError extends ScraperError {
    constructor(message = "scraper session timed out") {
        super(message, true);
    }
}
exports.SessionTimeoutError = SessionTimeoutError;
/**
 * Catch-all for unclassified scraper failures. Retryable by default so
 * transient issues (DOM not settled, network blips) get a second chance.
 */
class UnknownScraperError extends ScraperError {
    constructor(message = "unknown scraper failure") {
        super(message, true);
    }
}
exports.UnknownScraperError = UnknownScraperError;
//# sourceMappingURL=errors.js.map