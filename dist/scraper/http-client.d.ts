import type Bottleneck from "bottleneck";
import type { ZodType } from "zod/v4";
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
export declare function createHttpClient<TResponse>(options: HttpClientOptions<TResponse>): (url: string, init?: HttpRequestInit) => Promise<TResponse>;
