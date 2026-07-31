/**
 * No message matching the inbox filter arrived before the wait budget
 * elapsed. Callers usually want to either widen the timeout or treat this
 * as a real failure (the site didn't send the confirmation email).
 */
export class TestmailTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The testmail.app GraphQL API returned a non-success `result` field or an
 * HTTP error that the underlying HTTP client surfaced. Distinct from
 * timeout so call-sites can decide whether to retry (rate limit, transient
 * 5xx) or fail loud (bad API key, missing namespace).
 */
export class TestmailApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
