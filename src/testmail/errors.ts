/**
 * No message matching the inbox filter arrived before the wait budget
 * elapsed. Callers usually want to either widen the timeout or treat this
 * as a real failure (the site didn't send the confirmation email).
 */
export class TestmailTimeoutError extends Error {
  /**
   * What a REST `api/json` probe said after every GraphQL attempt failed:
   * `reachable_no_mail` (API healthy, inbox empty), `service_unavailable`
   * (REST failed too), or `undetermined` (GraphQL answered at least once, so
   * no probe was needed).
   */
  readonly serviceStatus: TestmailServiceStatus;

  constructor(message: string, serviceStatus: TestmailServiceStatus = "undetermined") {
    super(message);
    this.name = new.target.name;
    this.serviceStatus = serviceStatus;
  }
}

export type TestmailServiceStatus = "reachable_no_mail" | "service_unavailable" | "undetermined";

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
