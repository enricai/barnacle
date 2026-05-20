import type Bottleneck from "bottleneck";
import pRetry, { AbortError } from "p-retry";
import type { ZodType } from "zod/v4";

import { getLogger } from "@/lib/logging";
import {
  HttpBotChallengeError,
  HttpRateLimitError,
  HttpSchemaError,
  HttpServerError,
  UnknownScraperError,
} from "@/scraper/errors";

const logger = getLogger({ name: "scraper/http-client" });

/**
 * Static configuration passed to `createHttpClient` once per plugin. Bundles
 * the Zod response schema, the Bottleneck rate limiter, and the load-bearing
 * headers discovered during recon so each per-call invocation only needs the
 * URL and request body.
 */
export interface HttpClientOptions<TResponse> {
  /** Zod schema that validates and narrows the response body. */
  schema: ZodType<TResponse>;
  /** Per-plugin Bottleneck instance that rate-limits outbound requests. */
  bottleneck: Bottleneck;
  /** Load-bearing headers committed from recon — Origin, Referer, User-Agent, etc. */
  baseHeaders: Record<string, string>;
}

/**
 * Per-call overrides forwarded to the underlying `fetch()`. A strict subset of
 * the browser `RequestInit` API — keeps the interface portable and prevents
 * callers from bypassing the Bottleneck or Zod layers by passing raw fetch
 * options that the client doesn't know about.
 */
export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Factory that creates a typed direct-HTTP request function pre-wired with
 * the plugin's Bottleneck limiter, p-retry for transient network failures,
 * and Zod response schema. This is the hot-path runtime: no browser, no LLM
 * tokens, millisecond latency.
 *
 * Hot-path chain per spec §5A:
 *   lru-cache (response cache, in dispatch layer)
 *   → fetch(endpoint) → bottleneck (rate limit) → p-retry (transient failures)
 *   → zod.parse(response) → return
 *
 * Throws `HttpSchemaError` when the response body doesn't match the schema —
 * dispatch() uses that as the trigger to fall back to the Stagehand path.
 * Throws `HttpBotChallengeError` on 401/403 — also a fallback trigger.
 * Throws `HttpServerError` on 5xx — also a fallback trigger; a server-side
 * outage is not the same as a bot block but the recovery is identical.
 * Throws `HttpRateLimitError` on 429 — NOT a fallback trigger; the caller
 * should back off, not burn a Steel session.
 * Wraps transient network errors in `UnknownScraperError` and retries up to
 * 2 times with exponential backoff before propagating.
 */
export function createHttpClient<TResponse>(
  options: HttpClientOptions<TResponse>
): (url: string, init?: HttpRequestInit) => Promise<TResponse> {
  const { schema, bottleneck, baseHeaders } = options;

  return async (url: string, init: HttpRequestInit = {}): Promise<TResponse> => {
    return bottleneck.schedule(() =>
      pRetry(
        async () => {
          const method = init.method ?? "GET";
          const headers = { ...baseHeaders, ...(init.headers ?? {}) };

          let response: Response;
          try {
            response = await fetch(url, { method, headers, body: init.body });
          } catch (err) {
            // Network-level failure (DNS, TCP reset, timeout) — retryable.
            throw new UnknownScraperError(`http fetch failed: ${String(err)}`);
          }

          if (response.status === 401 || response.status === 403) {
            // Bot challenge / auth wall — not a transient failure, abort retry.
            throw new AbortError(
              new HttpBotChallengeError(
                `http ${response.status} from ${url} — bot challenge or auth required`
              )
            );
          }

          if (response.status === 429) {
            // Rate limit — not a transient failure, abort retry.
            throw new AbortError(
              new HttpRateLimitError(`http 429 from ${url} — rate limit exceeded`)
            );
          }

          if (response.status >= 500) {
            // Server error — non-retryable at the HTTP level; dispatch() will
            // engage the browser fallback instead.
            throw new AbortError(new HttpServerError(`http ${response.status} from ${url}`));
          }

          let body: unknown;
          try {
            body = await response.json();
          } catch (err) {
            // Malformed JSON — not transient, abort retry.
            throw new AbortError(
              new HttpSchemaError(`response body is not valid JSON: ${String(err)}`)
            );
          }

          const parsed = schema.safeParse(body);
          if (!parsed.success) {
            logger.warn(
              `http schema mismatch from ${url}: ${parsed.error.issues.map((i) => i.message).join("; ")}`
            );
            // Schema mismatch — not transient, abort retry.
            throw new AbortError(
              new HttpSchemaError(
                `response schema mismatch: ${parsed.error.issues.map((i) => i.message).join("; ")}`
              )
            );
          }

          return parsed.data;
        },
        {
          retries: 2,
          factor: 2,
          minTimeout: 200,
          maxTimeout: 1_000,
          randomize: true,
          onFailedAttempt: (error) => {
            logger.warn(
              `http hot-path attempt ${error.attemptNumber} failed: ${error.message}; ${error.retriesLeft} retries left`
            );
          },
        }
      )
    );
  };
}
