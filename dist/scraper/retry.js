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
const logging_1 = require("@/lib/logging");
const errors_1 = require("@/scraper/errors");
const logger = (0, logging_1.getLogger)({ name: "scraper/retry" });
/**
 * Wraps a scraper task with p-retry and a classification policy aligned
 * with our ScraperError hierarchy:
 *
 * - CaptchaError + EmptyResultsError → AbortError, no retry.
 * - SessionTimeoutError → invoke onSessionRestart, then retry once.
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
            if (err instanceof errors_1.CaptchaError || err instanceof errors_1.EmptyResultsError) {
                throw new p_retry_1.AbortError(err.message);
            }
            if (err instanceof errors_1.SessionTimeoutError && !sessionRestartEntry.done) {
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
        onFailedAttempt: async (error) => {
            const wrapped = error;
            logger.warn(`scraper attempt ${error.attemptNumber} failed (${wrapped.name}): ${error.message}; ${error.retriesLeft} retries left`);
            if (options.onRetry && wrapped instanceof errors_1.ScraperError) {
                await options.onRetry(wrapped, error.attemptNumber);
            }
        },
    });
}
/**
 * Maps a raw thrown value (Error, string, or anything) onto our typed
 * ScraperError hierarchy so the retry policy can branch on it.
 */
function classifyScraperError(raw) {
    if (raw instanceof errors_1.ScraperError)
        return raw;
    const message = raw instanceof Error ? raw.message : String(raw);
    const lower = message.toLowerCase();
    if (lower.includes("captcha"))
        return new errors_1.CaptchaError(message);
    if (lower.includes("timeout") || lower.includes("timed out")) {
        return new errors_1.SessionTimeoutError(message);
    }
    if (lower.includes("selector") ||
        lower.includes("could not find") ||
        lower.includes("not found")) {
        return new errors_1.SelectorFailureError(message);
    }
    if (lower.includes("empty") || lower.includes("no results")) {
        return new errors_1.EmptyResultsError(message);
    }
    return new errors_1.UnknownScraperError(message);
}
//# sourceMappingURL=retry.js.map