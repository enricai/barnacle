import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type Bottleneck from "bottleneck";
import pRetry, { AbortError } from "p-retry";
import type { ZodType } from "zod/v4";

import { getLogger } from "@/lib/logging";
import {
  HttpBotChallengeError,
  HttpRateLimitError,
  HttpSchemaError,
  HttpServerError,
  HttpUrlLockedError,
  OracleTokenExpiredError,
  UnknownScraperError,
} from "@/scraper/errors";
import { classifyOracleSentinel } from "@/scraper/oracle-sentinels";

const logger = getLogger({ name: "scraper/http-client" });

/**
 * One-shot diagnostic: when `CAPTURE_BASELINE_BODIES=1`, write each successful
 * (2xx) request to a numbered JSON file under the destination directory
 * (`BASELINE_BODIES_DIR`, default `/tmp/baseline-bodies`). Used to
 * snapshot the current hot-path request shapes as a frozen regression baseline
 * before refactors that would alter how the JSON bodies are built. Off in
 * production unless explicitly enabled.
 */
let baselineCallCounter = 0;

/**
 * Payload surfaced to the optional `onResponse` hook. Provides the raw HTTP
 * outcome before any error classification or body parsing so callers can read
 * headers (e.g. token-rotation, audit) regardless of status code.
 */
export interface HttpResponseInfo {
  status: number;
  headers: Headers;
  url: string;
}

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
  /**
   * Optional hook invoked on every fetch outcome — including non-2xx — before
   * error classification. Use to inspect response headers (e.g. token rotation)
   * or capture audit data without bypassing the core client.
   */
  onResponse?: (info: HttpResponseInfo) => void;
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
  /**
   * Cancels the underlying `fetch()` and short-circuits the p-retry loop
   * when the signal aborts. Required for callers that long-poll endpoints
   * (e.g. testmail's `livequery: true`) where a single request can
   * outlast the caller's overall budget — Node's built-in fetch has no
   * default timeout, so without a signal the request hangs the socket
   * until the server closes it (~15min for testmail livequery).
   */
  signal?: AbortSignal;
}

/**
 * Parses `rawText` as JSON. Oracle HCM `ORA_IRC_*` transient sentinels are
 * caught before this call and thrown as {@link OracleTokenExpiredError}.
 * On any JSON parse failure for a non-sentinel body, logs the first 200 chars
 * and throws `UnknownScraperError` (retryable) so p-retry re-issues the
 * request rather than hard-aborting with `HttpSchemaError`.
 */
function parseJsonOrThrowRetryable(rawText: string, url: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch (err) {
    logger.warn(`non-JSON response body from ${url} (first 200 chars): ${rawText.slice(0, 200)}`);
    throw new UnknownScraperError(`response body is not valid JSON: ${String(err)}`);
  }
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
  const { schema, bottleneck, baseHeaders, onResponse } = options;

  return async (url: string, init: HttpRequestInit = {}): Promise<TResponse> => {
    return bottleneck.schedule(() =>
      pRetry(
        async () => {
          const method = init.method ?? "GET";
          const headers = { ...baseHeaders, ...(init.headers ?? {}) };

          let response: Response;
          try {
            response = await fetch(url, {
              method,
              headers,
              body: init.body,
              signal: init.signal,
            });
          } catch (err) {
            // Caller-triggered cancellation — propagate without retry. The
            // outer p-retry's own `signal` option will also throwIfAborted
            // on its retry-loop boundaries, but wrapping in AbortError here
            // covers the window between fetch dispatch and the next signal
            // check inside pRetry.
            if (err instanceof Error && err.name === "AbortError") {
              throw new AbortError(err);
            }
            // Network-level failure (DNS, TCP reset, timeout) — retryable.
            throw new UnknownScraperError(`http fetch failed: ${String(err)}`);
          }

          onResponse?.({ status: response.status, headers: response.headers, url });

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

          if (process.env.CAPTURE_BASELINE_BODIES === "1") {
            try {
              const dir = process.env.BASELINE_BODIES_DIR ?? "/tmp/baseline-bodies";
              mkdirSync(dir, { recursive: true });
              const idx = String(baselineCallCounter++).padStart(2, "0");
              const slug =
                new URL(url).pathname
                  .split("/")
                  .filter(Boolean)
                  .slice(-2)
                  .join("-")
                  .replace(/[^a-zA-Z0-9._-]/g, "_") || "root";
              const target = join(dir, `${idx}-${method}-${slug}.json`);
              writeFileSync(
                target,
                JSON.stringify(
                  {
                    method,
                    url,
                    status: response.status,
                    requestHeaders: headers,
                    requestBody: init.body ?? null,
                  },
                  null,
                  2
                )
              );
              logger.warn(`baseline-body captured: ${target}`);
            } catch (err) {
              logger.warn(
                `baseline-body capture failed: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }

          const rawText = await response.text();

          const sentinelKind = classifyOracleSentinel(rawText);
          if (sentinelKind === "locked") {
            // Oracle has locked the requisition URL — retrying cannot succeed.
            throw new AbortError(
              new HttpUrlLockedError(`oracle url locked (ORA_URL_LOCKED) from ${url}`)
            );
          }
          if (sentinelKind === "transient") {
            // Oracle returned an ORA_IRC_* token-expiry sentinel — retryable,
            // but kept distinct from UnknownScraperError so the encompass flow
            // can catch exactly this class and re-mint the AccessCode.
            throw new OracleTokenExpiredError(
              `oracle token expired from ${url}: ${rawText.trim().slice(0, 200)}`
            );
          }

          const body = parseJsonOrThrowRetryable(rawText, url);

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
          signal: init.signal,
          onFailedAttempt: (context) => {
            logger.warn(
              `http hot-path attempt ${context.attemptNumber} failed: ${context.error.message}; ${context.retriesLeft} retries left`
            );
          },
        }
      )
    );
  };
}
