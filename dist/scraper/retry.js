"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.withScraperRetry = withScraperRetry;
exports.classifyScraperError = classifyScraperError;
const p_retry_1 = __importStar(require("p-retry"));
const errors_1 = require("../lib/errors");
const logging_1 = require("../lib/logging");
const errors_2 = require("../scraper/errors");
const logger = (0, logging_1.getLogger)({ name: "scraper/retry" });
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
async function withScraperRetry(task, options = {}) {
    const maxAttempts = options.maxAttempts ?? 3;
    const sessionRestartEntry = { done: false };
    return (0, p_retry_1.default)(async () => {
        try {
            return await task();
        }
        catch (raw) {
            const err = classifyScraperError(raw);
            if (err instanceof errors_2.CaptchaError) {
                // Task 10: CAPTCHA hit — log it. p-retry skips onFailedAttempt
                // for AbortError, so the warn log below is the only signal a
                // captcha was encountered before it propagates to callers.
                logger.error(`captcha encountered upstream — aborting retry: ${err.message}`);
                throw new p_retry_1.AbortError(err.message);
            }
            if (err instanceof errors_2.EmptyResultsError) {
                logger.warn(`scraper returned empty results — aborting retry: ${err.message}`);
                throw new p_retry_1.AbortError(err.message);
            }
            if (err instanceof errors_2.SessionTimeoutError && !sessionRestartEntry.done) {
                sessionRestartEntry.done = true;
                if (options.onSessionRestart) {
                    await options.onSessionRestart();
                }
            }
            throw err;
        }
    }, {
        retries: Math.max(0, maxAttempts - 1),
        factor: 2,
        minTimeout: 500,
        maxTimeout: 5_000,
        randomize: true,
        onFailedAttempt: async (context) => {
            const { error, attemptNumber, retriesLeft } = context;
            logger.warn(`scraper attempt ${attemptNumber} failed (${error.name}): ${error.message}; ${retriesLeft} retries left`);
            if (options.onRetry && error instanceof errors_2.ScraperError) {
                await options.onRetry(error, attemptNumber);
            }
        },
    });
}
/**
 * Maps a raw thrown value (Error, string, or anything) onto our typed
 * ScraperError hierarchy so the retry policy can branch on it.
 */
function classifyScraperError(raw) {
    if (raw instanceof errors_2.ScraperError)
        return raw;
    const message = (0, errors_1.toErrorMessage)(raw);
    const lower = message.toLowerCase();
    if (lower.includes("captcha"))
        return new errors_2.CaptchaError(message);
    if (lower.includes("timeout") || lower.includes("timed out")) {
        return new errors_2.SessionTimeoutError(message);
    }
    if (lower.includes("selector") ||
        lower.includes("could not find") ||
        lower.includes("not found")) {
        return new errors_2.SelectorFailureError(message);
    }
    if (lower.includes("empty") || lower.includes("no results")) {
        return new errors_2.EmptyResultsError(message);
    }
    return new errors_2.UnknownScraperError(message);
}
//# sourceMappingURL=retry.js.map