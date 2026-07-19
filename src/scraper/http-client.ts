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
  type ScraperError,
  UnknownScraperError,
} from "@/scraper/errors";

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
 * Declares a single named value to capture from a response and echo back as
 * a request header on later calls made by the same client instance. Models
 * the disneycruise-style pattern where one call mints a bearer via
 * `Set-Cookie` and a later stateful call 401s without it — extends the
 * response-body state-threading the emitter already speaks (`produces`) to
 * response headers, instead of a general cookie jar (see http-client.ts
 * module docblock and CLAUDE.md "battle-tested libraries only": a real jar
 * with domain/path/expiry matching belongs to a library like tough-cookie,
 * not a hand-rolled one, and the sites this closes only need a single opaque
 * value echoed back verbatim).
 */
export interface HttpResponseBinding {
  /**
   * Response header to read from. Use `"set-cookie"` (case-insensitive) to
   * read from `Set-Cookie` specifically — multiple `Set-Cookie` entries are
   * read via `Headers.getSetCookie()` so they aren't comma-joined the way
   * `Headers.get()` joins ordinary repeated headers.
   */
  sourceHeader: string;
  /**
   * For `sourceHeader: "set-cookie"`, the cookie name to extract (e.g.
   * `"__pa"`) — the binding reads that cookie's value out of whichever
   * `Set-Cookie` entry defines it. Ignored for non-cookie source headers,
   * whose raw value is bound as-is.
   */
  cookieName?: string;
  /**
   * Outbound request header to populate on subsequent calls, e.g. `"Cookie"`.
   * Multiple bindings with a `cookieName` may share the same `targetHeader`
   * (the `Cookie` header carries many cookies) — each is tracked separately
   * and materialized joined by `"; "`. Bindings without `cookieName` bind a
   * raw header value as-is and keep overwrite semantics: a second such
   * binding sharing a `targetHeader` replaces the first.
   */
  targetHeader: string;
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
  /**
   * Named response-header/cookie values to capture on one call and forward as
   * a request header on subsequent calls from the same client instance (e.g.
   * a token-mint call's `Set-Cookie` echoed back on the next stateful call).
   * Evaluated at the same point as `onResponse` — every fetch outcome,
   * including non-2xx. A binding whose source is absent from a given
   * response leaves any previously-bound value untouched; if nothing has
   * ever been bound, the target header is simply omitted from later
   * requests rather than sent empty.
   */
  bind?: HttpResponseBinding[];
  /**
   * Optional plugin-supplied classifier for a response body the core client
   * cannot interpret — an ATS that answers with a plain-text sentinel instead of
   * JSON, say. Called with the raw body text on every fetch outcome; return a
   * {@link ScraperError} to short-circuit (its `retryable` flag decides retry vs
   * abort), or `undefined` to fall through to the normal JSON-parse path. This
   * is how vendor-specific wire quirks stay in the plugin instead of the engine.
   */
  classifyResponseBody?: (rawText: string, ctx: { url: string }) => ScraperError | undefined;
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
 * Parses `rawText` as JSON. Any plugin-supplied `classifyResponseBody` runs
 * before this, so a recognized non-JSON sentinel is already handled.
 * On any JSON parse failure for an unclassified body, logs the first 200 chars
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
 * Extracts one cookie's value from a set of raw `Set-Cookie` header strings.
 * Reads via `Headers.getSetCookie()` (not `.get("set-cookie")`, which joins
 * multiple entries with commas and would corrupt the individual cookie-pair
 * boundaries) so multi-cookie responses resolve correctly.
 */
function extractCookieValue(setCookieHeaders: string[], cookieName: string): string | undefined {
  for (const entry of setCookieHeaders) {
    const pair = entry.split(";", 1)[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === cookieName) {
      return pair.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/**
 * Resolves one {@link HttpResponseBinding} against a response's headers.
 * Returns `undefined` on a miss (source header/cookie absent) so the caller
 * can leave a previously-bound value untouched instead of overwriting it
 * with an empty string — see `HttpClientOptions.bind` for why a miss must
 * not fabricate a value.
 */
function resolveBinding(binding: HttpResponseBinding, headers: Headers): string | undefined {
  if (binding.sourceHeader.toLowerCase() === "set-cookie") {
    return binding.cookieName
      ? extractCookieValue(headers.getSetCookie(), binding.cookieName)
      : (headers.getSetCookie()[0] ?? undefined);
  }
  return headers.get(binding.sourceHeader) ?? undefined;
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
  const { schema, bottleneck, baseHeaders, onResponse, bind = [], classifyResponseBody } = options;
  // Values bound from prior responses (e.g. a minted auth cookie), keyed by
  // targetHeader. Lives for the lifetime of this client instance so a later
  // call can pick up what an earlier call captured — see HttpResponseBinding.
  const boundHeaders: Record<string, string> = {};
  // Per-cookie values for targetHeaders that carry multiple cookies (e.g.
  // "Cookie"), keyed by targetHeader then cookieName so several bindings
  // sharing one targetHeader accumulate instead of overwriting — see
  // HttpResponseBinding.targetHeader. Materialized into boundHeaders
  // (joined by "; ") whenever an entry changes.
  const boundCookiesByTarget = new Map<string, Map<string, string>>();

  return async (url: string, init: HttpRequestInit = {}): Promise<TResponse> => {
    return bottleneck.schedule(() =>
      pRetry(
        async () => {
          const method = init.method ?? "GET";
          const headers = { ...baseHeaders, ...boundHeaders, ...(init.headers ?? {}) };

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

          for (const binding of bind) {
            const value = resolveBinding(binding, response.headers);
            // A miss leaves any previously-bound value in place rather than
            // clearing it — and if nothing has ever been bound, the target
            // header stays absent from `boundHeaders` entirely, so later
            // requests never send it as an empty string.
            if (value === undefined) continue;
            if (binding.cookieName === undefined) {
              boundHeaders[binding.targetHeader] = value;
              continue;
            }
            const cookies =
              boundCookiesByTarget.get(binding.targetHeader) ?? new Map<string, string>();
            cookies.set(binding.cookieName, value);
            boundCookiesByTarget.set(binding.targetHeader, cookies);
            boundHeaders[binding.targetHeader] = [...cookies.entries()]
              .map(([name, cookieValue]) => `${name}=${cookieValue}`)
              .join("; ");
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

          // A plugin may recognize a non-JSON response body the engine can't
          // (a vendor sentinel). Its verdict drives retry via the error's
          // `retryable` flag: non-retryable aborts the p-retry loop, retryable
          // is re-thrown so p-retry re-issues. `undefined` falls through.
          const classified = classifyResponseBody?.(rawText, { url });
          if (classified !== undefined) {
            throw classified.retryable ? classified : new AbortError(classified);
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
