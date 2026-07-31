import Bottleneck from "bottleneck";
import type { ZodType } from "zod/v4";

import { chromiumClientHints } from "@/lib/chromium-client-hints";
import type { HttpClientOptions, HttpRequestInit } from "@/scraper/http-client";
import { createHttpClient } from "@/scraper/http-client";

/**
 * Options for building a Chromium-flavoured rate-limited JSON client.
 * Bundles the Bottleneck configuration, Chromium client-hint values, and any
 * site-specific headers into one call so each plugin avoids hand-rolling the
 * identical scaffold.
 */
export interface RateLimitedJsonClientOptions<TResponse> {
  /** Bottleneck `minTime` in milliseconds (inverse of requests-per-second ceiling). */
  minTimeMs: number;
  /** Full User-Agent string captured during recon. */
  userAgent: string;
  /** `sec-ch-ua` header value captured during recon. */
  secChUa: string;
  /** Platform string for `sec-ch-ua-platform`, e.g. `"Linux"`. */
  platform: string;
  /**
   * Site-specific headers layered on top of the Chromium client-hint quartet.
   * These are merged last, so a plugin can override a hint value if recon
   * demands it.
   */
  extraHeaders?: Record<string, string>;
  /** Zod schema that validates and narrows each response body. */
  schema: ZodType<TResponse>;
  /**
   * Optional plugin-supplied response-body classifier, forwarded verbatim to
   * {@link createHttpClient} — lets a plugin recognize a vendor sentinel body
   * (e.g. a plain-text token) without the engine knowing that vendor's wire
   * format. See {@link HttpClientOptions.classifyResponseBody}.
   */
  classifyResponseBody?: HttpClientOptions<TResponse>["classifyResponseBody"];
}

/**
 * Site-agnostic factory that wires together Bottleneck + chromiumClientHints +
 * createHttpClient so individual plugins don't repeat the same three-step
 * scaffold. Each plugin supplies its own `minTimeMs`, Chromium hint values,
 * and site-specific `extraHeaders`; the factory owns the limiter lifecycle and
 * the header merge order (hints first, extraHeaders on top).
 */
export function createRateLimitedJsonClient<TResponse>(
  opts: RateLimitedJsonClientOptions<TResponse>
): <TOverride = TResponse>(url: string, init?: HttpRequestInit<TOverride>) => Promise<TOverride> {
  const bottleneck = new Bottleneck({ minTime: opts.minTimeMs });
  const baseHeaders: Record<string, string> = {
    ...chromiumClientHints({
      userAgent: opts.userAgent,
      secChUa: opts.secChUa,
      platform: opts.platform,
    }),
    ...(opts.extraHeaders ?? {}),
  };
  return createHttpClient({
    schema: opts.schema,
    bottleneck,
    baseHeaders,
    classifyResponseBody: opts.classifyResponseBody,
  });
}
