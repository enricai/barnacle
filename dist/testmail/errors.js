"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestmailApiError = exports.TestmailTimeoutError = void 0;
/**
 * No message matching the inbox filter arrived before the wait budget
 * elapsed. Callers usually want to either widen the timeout or treat this
 * as a real failure (the site didn't send the confirmation email).
 */
class TestmailTimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = new.target.name;
    }
}
exports.TestmailTimeoutError = TestmailTimeoutError;
/**
 * The testmail.app GraphQL API returned a non-success `result` field or an
 * HTTP error that the underlying HTTP client surfaced. Distinct from
 * timeout so call-sites can decide whether to retry (rate limit, transient
 * 5xx) or fail loud (bad API key, missing namespace).
 */
class TestmailApiError extends Error {
    constructor(message) {
        super(message);
        this.name = new.target.name;
    }
}
exports.TestmailApiError = TestmailApiError;
//# sourceMappingURL=errors.js.map