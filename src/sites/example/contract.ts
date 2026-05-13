/**
 * Codified contract for the "example" site — the pattern every real site plugin
 * follows after completing the recon playbook steps.
 *
 * Step 4a: hand-write a lean query/payload from each auto-captured one.
 * Step 4b: commit load-bearing headers from recon-http.ts as BASE_HEADERS.
 * Step 4c: commit the rate-limit ceiling from the probe as the Bottleneck config.
 * Step 4d: write Zod schemas against captured JSON (or codegen from introspection).
 *
 * Replace every "example.com" value with the real site and delete this comment.
 */

import Bottleneck from "bottleneck";
import { z } from "zod";

// import { loadFixture } from "@/scraper/fixtures";
import { createGraphqlClient } from "@/scraper/graphql-client";
import type { BrowserSession } from "@/scraper/session";
import type { SitePlugin, SitePluginContext, SitePluginResult } from "@/site-plugin";
import { runExampleBrowserFlow } from "@/sites/example/flows/browser-flow";

// Step 4b: load-bearing headers identified by recon-http.ts replay.
// Only Origin, Referer, User-Agent, Content-Type, and Accept survived as
// necessary — all others were decorative (dropped from RC_HEADERS).
const BASE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json, */*",
  Origin: "https://example.com",
  Referer: "https://example.com/",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

// Step 4c: Bottleneck ceiling from the rate-limit probe (5 rps safe ceiling).
// minTime = 1000ms / 5rps = 200ms minimum gap between requests.
const limiter = new Bottleneck({ minTime: 200 });

// Step 4d: Zod response schema written against captured JSON.
// These schemas double as runtime drift detectors — a schema mismatch
// throws HttpSchemaError, which dispatch() uses to trigger the browser fallback.
const ExampleItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Add the fields your integration actually needs — strip UI-only fields.
});

const ExampleResponseSchema = z.object({
  data: z.object({
    items: z.array(ExampleItemSchema),
  }),
});

export type ExampleItem = z.infer<typeof ExampleItemSchema>;
export type ExampleResponse = z.infer<typeof ExampleResponseSchema>;

// Default export for --response-schema in smoke-test.ts. Point the flag at
// this file and the smoke test will validate the full response body against
// this schema on every nightly run.
export default ExampleResponseSchema;

// Request body schema — validated by core before execute() is called.
const ExamplePayloadSchema = z.object({
  query: z.string().min(1).max(200),
});

export type ExamplePayload = z.infer<typeof ExamplePayloadSchema>;

// Step 4a: lean query committed from recon — only fields this integration needs.
const EXAMPLE_SEARCH_QUERY = `query ExampleSearch($q: String!) {
  items(query: $q) { id name }
}`;

type GqlFn = (
  operationName: string,
  query: string,
  variables: Record<string, unknown>
) => Promise<ExampleResponse>;

// Memoize by baseUrl — in practice there is only one value (the default or env
// override), but memoizing avoids re-allocating closures on every request.
const gqlCache = new Map<string, GqlFn>();

function getGql(baseUrl: string): GqlFn {
  let client = gqlCache.get(baseUrl);
  if (!client) {
    client = createGraphqlClient({
      schema: ExampleResponseSchema,
      bottleneck: limiter,
      baseHeaders: BASE_HEADERS,
      endpoint: `${baseUrl}/api/search`,
    });
    gqlCache.set(baseUrl, client);
  }
  return client;
}

// Step 3B (optional): if recon-http.ts found static JSON fixtures (markets,
// currencies, labels, etc.), commit them to src/sites/example/fixtures/ and
// load them here instead of re-fetching on every production call.
//
// const MarketsSchema = z.array(z.object({ id: z.string(), name: z.string() }));
// const markets = loadFixture("example", "markets.json", MarketsSchema);

/**
 * Site plugin for example.com. Registers a POST /v1/example/run route that
 * tries the direct-HTTP hot path first, falling back to Stagehand automatically
 * on schema mismatch or bot challenge.
 */
export const examplePlugin: SitePlugin<ExamplePayload, ExampleResponse> = {
  meta: {
    siteId: "example",
    displayName: "Example Site",
    bodySchema: ExamplePayloadSchema,
    responseSchema: ExampleResponseSchema,
    defaultBaseUrl: "https://example.com",
  },

  /**
   * Hot path: direct HTTP to the API the SPA calls internally. ~50 lines of
   * fetch(), no browser, no LLM tokens. Invoked first on every production
   * request. dispatch() falls through to execute() automatically on failure.
   */
  async executeHttp(
    payload: ExamplePayload,
    context: SitePluginContext
  ): Promise<SitePluginResult<ExampleResponse>> {
    const data = await getGql(context.baseUrl)("ExampleSearch", EXAMPLE_SEARCH_QUERY, {
      q: payload.query,
    });
    return { data };
  },

  /**
   * Browser fallback: Stagehand + Steel session acquired from the pool by core.
   * Slower and more expensive — invoked only when the hot path fails.
   * Uses the same user flow from recon-browser.ts (Step 0).
   */
  async execute(
    payload: ExamplePayload,
    session: BrowserSession,
    context: SitePluginContext
  ): Promise<SitePluginResult<ExampleResponse>> {
    const raw = await runExampleBrowserFlow(session.stagehand, context.baseUrl, payload.query);
    return {
      data: { data: { items: raw.items as ExampleItem[] } },
      auditPayload: { query: payload.query, itemCount: raw.items.length },
    };
  },
};
