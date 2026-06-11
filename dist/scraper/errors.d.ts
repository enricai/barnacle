/**
 * Error hierarchy produced by the scraper. These are internal — they stay
 * inside the scraper + service layer and are translated into API envelope
 * errors (via src/api/errors.ts) before they reach the client.
 *
 * Why: each class encodes a distinct recovery policy that p-retry and the
 * session pool key off of. Some failures abort the whole call (no retry
 * can resolve them); others are retryable in place because a fresh AI
 * resolution or DOM re-settle usually fixes them; some need a brand-new
 * Steel session before retrying, in which case retry.ts invokes its
 * onRestart callback. See each class's TSDoc for its specific policy
 * and the diagnostic it represents.
 */
/**
 * Base class for all scraper-internal errors. Each subclass encodes a
 * distinct recovery policy (retryable or not) that retry.ts and loader.ts
 * key off of to decide whether to retry, restart the session, or abort.
 */
export declare abstract class ScraperError extends Error {
    readonly retryable: boolean;
    constructor(message: string, retryable: boolean);
}
/**
 * The scraper encountered a CAPTCHA challenge Steel couldn't solve on our
 * behalf. Propagate upstream as error code 2004.
 */
export declare class CaptchaError extends ScraperError {
    constructor(message?: string);
}
/**
 * The scrape completed but returned no data. This is not a failure — it's
 * a legitimate empty result (e.g. a search returned zero matches). The
 * service layer handles this without throwing.
 */
export declare class EmptyResultsError extends ScraperError {
    constructor(message?: string);
}
/**
 * Stagehand failed to resolve a selector or an `act()` call. The most
 * likely cause is that the cached action hash is stale because the target
 * page's UI changed. Retries bust the cache and fall back to fresh AI inference.
 */
export declare class SelectorFailureError extends ScraperError {
    constructor(message?: string);
}
/**
 * The upstream Steel browser session timed out or closed unexpectedly.
 * Needs a fresh session to retry — the session pool wrapper in retry.ts
 * honors this by invoking its `onRestart` hook before re-running.
 */
export declare class SessionTimeoutError extends ScraperError {
    constructor(message?: string);
}
/**
 * Catch-all for unclassified scraper failures. Retryable by default so
 * transient issues (DOM not settled, network blips) get a second chance.
 */
export declare class UnknownScraperError extends ScraperError {
    constructor(message?: string);
}
/** Discriminator for {@link StepVerificationError}. See the class TSDoc for the per-variant semantics. */
export type StepVerificationErrorKind = "cascade-exhausted" | "probe-absent" | "backend-error-unrecoverable" | "replan-cycle-detected";
/**
 * Recon-only: a flow step in recon-browser.ts could not be acted on. Four
 * variants per `kind`:
 *
 *   - "cascade-exhausted": the full 4-attempt self-healing cascade ran and
 *     none of the attempts produced an observable effect. Expensive (the
 *     cascade burned its full LLM/observe budget) — counted against the
 *     cascade replan budget.
 *   - "probe-absent": the cheap page-state probe ran BEFORE the cascade
 *     and observed zero candidates for the step's instruction. We skip the
 *     cascade and ask for a replan immediately because the page state is
 *     clearly off (e.g. flow expected the form-fill page but the SPA is
 *     still on the resume-upload screen). Cheap (~1 observe + 1 LLM call)
 *     — counted against the probe replan budget.
 *   - "backend-error-unrecoverable": the cascade detected a same-window
 *     5xx response from the configured submit endpoint. No amount of
 *     retry or replan can heal a server crash — the main flow loop
 *     special-cases this kind to bypass the replan dispatcher and
 *     propagate the error out, terminating the run with the diagnostic.
 *   - "replan-cycle-detected": the engine observed the replanner proposing
 *     the same multi-step instruction sequence under unchanged page state
 *     N times in a row (default 3). Further replans on this trajectory
 *     cannot converge — the main loop short-circuits to terminate the run
 *     instead of burning the remaining replan budget on a known fixed point.
 *
 * Non-retryable — the runtime path never sees this.
 */
export declare class StepVerificationError extends ScraperError {
    readonly kind: StepVerificationErrorKind;
    constructor(message?: string, kind?: StepVerificationErrorKind);
}
/**
 * The direct-HTTP hot path received a response that did not match the plugin's
 * Zod response schema. Non-retryable on the hot path — the dispatch layer uses
 * this as the trigger to fall back to the Stagehand browser path instead.
 */
export declare class HttpSchemaError extends ScraperError {
    constructor(message?: string);
}
/**
 * The direct-HTTP hot path received a non-2xx response that signals a bot
 * challenge or auth wall (403, 401). Non-retryable — fall back to Stagehand.
 */
export declare class HttpBotChallengeError extends ScraperError {
    constructor(message?: string);
}
/**
 * The direct-HTTP hot path received a 5xx server error. Non-retryable on the
 * hot path — dispatch uses this as a fallback trigger just like HttpSchemaError.
 * Kept distinct from HttpBotChallengeError so metrics and logs can tell apart
 * a target server outage from a bot-detection block.
 */
export declare class HttpServerError extends ScraperError {
    constructor(message?: string);
}
/**
 * The direct-HTTP hot path received a 429 rate-limit response. Non-retryable
 * and NOT a fallback trigger — a 429 means the configured rps ceiling is too
 * high; the right response is to back off and surface the metric, not burn a
 * Steel browser session.
 */
export declare class HttpRateLimitError extends ScraperError {
    constructor(message?: string);
}
/**
 * Thrown when code that translates stable semantic field keys (`address.city`,
 * `firstName`, `applicantGender`) into tenant-specific GUIDs via a runtime
 * form-map lookup cannot resolve one or more required keys.
 *
 * Use this in any future form-map / response-builder code so a missing field
 * surfaces LOUDLY with an actionable error in the server log — instead of
 * silently emitting an empty GUID and producing an HTTP 200 with missing data
 * (which is how the StatusCode="unlocked" bug on 2026-06-04 hid for hours).
 *
 * Non-retryable — a missing key in the form definition is a configuration /
 * tenant mismatch that retries won't fix; the dispatch layer should treat
 * this as a hot-path failure and engage the browser fallback.
 */
export declare class MissingFormMapKeyError extends ScraperError {
    readonly missingKeys: readonly string[];
    readonly context: string;
    constructor(missingKeys: readonly string[], context: string);
}
