import {
  HttpBotChallengeError,
  HttpRateLimitError,
  HttpSchemaError,
  HttpServerError,
} from "@/scraper/errors";

/**
 * Pure status→error classifier shared by all raw-fetch callers that cannot
 * use `createHttpClient` (e.g. multipart Buffer bodies, per-response header
 * rotation). Throws the appropriate typed `ScraperError` for any non-2xx
 * status; returns silently for 2xx so callers can proceed to body parsing.
 *
 * Deliberately does NOT wrap in `p-retry AbortError` — that is
 * `createHttpClient`'s concern. Direct callers that don't use p-retry get
 * plain throws that propagate naturally.
 */
export function classifyHttpStatus(
  status: number,
  rawBodySnippet: string,
  contextLabel: string
): void {
  if (status === 401 || status === 403) {
    throw new HttpBotChallengeError(`${contextLabel} returned ${status}: ${rawBodySnippet}`);
  }
  if (status === 429) {
    throw new HttpRateLimitError(`${contextLabel} returned ${status}: ${rawBodySnippet}`);
  }
  if (status >= 500) {
    throw new HttpServerError(`${contextLabel} returned ${status}: ${rawBodySnippet}`);
  }
  if (status >= 400) {
    throw new HttpSchemaError(`${contextLabel} returned ${status}: ${rawBodySnippet}`);
  }
}
