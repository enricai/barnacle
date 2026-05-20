import type Bottleneck from "bottleneck";
import type { ZodType } from "zod/v4";

import { createHttpClient } from "@/scraper/http-client";

export interface GraphqlClientOptions<TResponse> {
  /** Zod schema that validates and narrows the response body. */
  schema: ZodType<TResponse>;
  /** Per-plugin Bottleneck instance that rate-limits outbound requests. */
  bottleneck: Bottleneck;
  /** Load-bearing headers committed from recon — Origin, Referer, User-Agent, etc. */
  baseHeaders: Record<string, string>;
  /** GraphQL endpoint URL committed from recon (e.g. `https://example.com/graphql`). */
  endpoint: string;
}

/**
 * Factory that creates a typed GraphQL POST function pre-wired with the
 * plugin's Bottleneck limiter, p-retry, and Zod schema. Eliminates
 * per-plugin JSON.stringify boilerplate for the `{operationName, query,
 * variables}` envelope — every GraphQL site plugin shares this path.
 *
 * Delegates entirely to `createHttpClient` so all hot-path error semantics
 * (HttpSchemaError → fallback, HttpRateLimitError → no fallback, etc.)
 * behave identically regardless of whether the plugin calls fetch() directly
 * or goes through this helper.
 */
export function createGraphqlClient<TResponse>(
  options: GraphqlClientOptions<TResponse>
): (
  operationName: string,
  query: string,
  variables: Record<string, unknown>
) => Promise<TResponse> {
  const { schema, bottleneck, baseHeaders, endpoint } = options;

  const httpClient = createHttpClient({ schema, bottleneck, baseHeaders });

  return (
    operationName: string,
    query: string,
    variables: Record<string, unknown>
  ): Promise<TResponse> =>
    httpClient(endpoint, {
      method: "POST",
      body: JSON.stringify({ operationName, query, variables }),
    });
}
