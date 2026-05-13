import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { formatISO } from "date-fns";

import { getLogger } from "@/lib/logging";

const logger = getLogger({ name: "scripts/recon-http" });

const OUTPUT_DIR = "/tmp/recon";
const GRAPHQL_DIR = join(OUTPUT_DIR, "graphql");
const REPLAYS_DIR = join(OUTPUT_DIR, "replays");
const AUX_DIR = join(OUTPUT_DIR, "aux");

/**
 * Phase 2 of the recon pipeline — plain Node `fetch()` against RC's
 * public endpoints. Runs after `recon-browser.ts` has populated
 * `/tmp/recon/graphql/*.json`.
 *
 * Probes:
 *  1. GraphQL introspection on `/graph` and `/cruises/graph`.
 *  2. Headless replay of every captured GraphQL op.
 *  3. Aux JSON endpoints from the SPA (markets, dictionaries).
 *  4. Rate-limit probe — 60 sequential cruiseSearch_Cruises at ~5 rps.
 *     Runs LAST; if it bans the egress IP, we've learned something
 *     material (direct-HTTP strategy invalidated) without burning the
 *     Steel residential IP.
 */

const RC_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  accept: "application/json",
  origin: "https://www.royalcaribbean.com",
  referer: "https://www.royalcaribbean.com/cruises",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
};

interface IntrospectionResult {
  endpoint: string;
  status: number;
  enabled: boolean;
  typeCount: number | undefined;
  body: unknown;
  error: string | undefined;
}

async function probeIntrospection(endpoint: string): Promise<IntrospectionResult> {
  const query = `{ __schema { types { name kind } queryType { name } mutationType { name } } }`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: RC_HEADERS,
      body: JSON.stringify({ query }),
    });
    const text = await response.text();
    const body = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    })();
    const typed = body as { data?: { __schema?: { types?: unknown[] } } };
    return {
      endpoint,
      status: response.status,
      enabled: response.status === 200 && !!typed.data?.__schema,
      typeCount: typed.data?.__schema?.types?.length,
      body,
      error: undefined,
    };
  } catch (err) {
    return {
      endpoint,
      status: 0,
      enabled: false,
      typeCount: undefined,
      body: null,
      error: String(err),
    };
  }
}

interface Replay {
  file: string;
  operationName: string | undefined;
  url: string;
  status: number;
  ok: boolean;
  bodyLength: number;
  error: string | undefined;
}

async function replayCaptures(): Promise<Replay[]> {
  mkdirSync(REPLAYS_DIR, { recursive: true });
  const files = readdirSync(GRAPHQL_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const seen = new Set<string>();
  const replays: Replay[] = [];
  for (const file of files) {
    const raw = readFileSync(join(GRAPHQL_DIR, file), "utf8");
    const capture = JSON.parse(raw) as {
      url: string;
      operationName?: string;
      query?: string;
      variables?: unknown;
      requestPostData?: string | null;
    };
    if (!capture.query || !capture.url) continue;
    const dedupKey = `${capture.url}|${capture.operationName ?? ""}|${JSON.stringify(capture.variables ?? null)}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    try {
      const response = await fetch(capture.url, {
        method: "POST",
        headers: RC_HEADERS,
        body:
          capture.requestPostData ??
          JSON.stringify({
            operationName: capture.operationName,
            query: capture.query,
            variables: capture.variables,
          }),
      });
      const text = await response.text();
      const outFile = join(
        REPLAYS_DIR,
        `${(capture.operationName ?? "anon").replace(/[^A-Za-z0-9_-]/g, "_")}-${seen.size}.json`
      );
      writeFileSync(
        outFile,
        JSON.stringify(
          {
            capturedAt: formatISO(new Date()),
            source: file,
            operationName: capture.operationName,
            url: capture.url,
            requestPostData: capture.requestPostData,
            status: response.status,
            responseHeaders: Object.fromEntries(response.headers.entries()),
            responseBody: text,
          },
          null,
          2
        )
      );
      replays.push({
        file,
        operationName: capture.operationName,
        url: capture.url,
        status: response.status,
        ok: response.ok,
        bodyLength: text.length,
        error: undefined,
      });
    } catch (err) {
      replays.push({
        file,
        operationName: capture.operationName,
        url: capture.url,
        status: 0,
        ok: false,
        bodyLength: 0,
        error: String(err),
      });
    }
  }
  return replays;
}

const AUX_ENDPOINTS: Array<{ slug: string; url: string; note: string }> = [
  {
    slug: "markets-all",
    url: "https://www.royalcaribbean.com/bin/services/royal/markets/all",
    note: "market/office/currency taxonomy — potentially maps 1:1 to VPS market triplet",
  },
  {
    slug: "cruise-search-dictionary",
    url: "https://www.royalcaribbean.com/bin/services/royal/dictionary?dictName=cruise-search%2Fwidget&langCd=en",
    note: "widget label strings",
  },
  {
    slug: "search-bar-dictionary",
    url: "https://www.royalcaribbean.com/search/bar/dictionary",
    note: "search-bar dictionary",
  },
  {
    slug: "search-suggestions",
    url: "https://www.royalcaribbean.com/intelligence/api/v2/search/suggestions?countryCode=USA&language=en",
    note: "typeahead suggestions — may expose destination/port tokens",
  },
  {
    slug: "search-trending",
    url: "https://www.royalcaribbean.com/search/trending?countryCode=USA&language=en",
    note: "trending searches",
  },
  {
    slug: "markets-suggested",
    url: "https://www.royalcaribbean.com/bin/services/royal/markets/suggested?country=USA",
    note: "suggested market for country",
  },
];

interface AuxResult {
  slug: string;
  url: string;
  status: number;
  contentType: string | null;
  bytes: number;
  ok: boolean;
  note: string;
  error: string | undefined;
}

async function probeAux(): Promise<AuxResult[]> {
  mkdirSync(AUX_DIR, { recursive: true });
  const results: AuxResult[] = [];
  for (const aux of AUX_ENDPOINTS) {
    try {
      const response = await fetch(aux.url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": RC_HEADERS["user-agent"] ?? "",
          referer: "https://www.royalcaribbean.com/cruises",
        },
      });
      const text = await response.text();
      writeFileSync(
        join(AUX_DIR, `${aux.slug}.json`),
        JSON.stringify(
          {
            capturedAt: formatISO(new Date()),
            url: aux.url,
            status: response.status,
            contentType: response.headers.get("content-type"),
            responseBody: text,
          },
          null,
          2
        )
      );
      results.push({
        slug: aux.slug,
        url: aux.url,
        status: response.status,
        contentType: response.headers.get("content-type"),
        bytes: text.length,
        ok: response.ok,
        note: aux.note,
        error: undefined,
      });
    } catch (err) {
      results.push({
        slug: aux.slug,
        url: aux.url,
        status: 0,
        contentType: null,
        bytes: 0,
        ok: false,
        note: aux.note,
        error: String(err),
      });
    }
  }
  return results;
}

interface RateLimitResult {
  capturedAt: string;
  totalRequests: number;
  successes: number;
  throttled: number;
  otherFailures: number;
  firstThrottleAt: number | null;
  observations: Array<{
    i: number;
    status: number;
    retryAfter: string | null;
    rateLimitRemaining: string | null;
    server: string | null;
    akamai: string | null;
    elapsedMs: number;
  }>;
  stopped: string;
}

async function probeRateLimit(): Promise<RateLimitResult> {
  const MAX = 60;
  const TARGET_RPS = 5;
  const INTERVAL_MS = Math.round(1000 / TARGET_RPS);
  const body = JSON.stringify({
    operationName: "cruiseSearch_Cruises",
    query:
      "query cruiseSearch_Cruises($sort:CruiseSearchSort,$pagination:CruiseSearchPagination){cruiseSearch(sort:$sort,pagination:$pagination){results{cruises{id productViewLink lowestPriceSailing{id sailDate}}total}}}",
    variables: { sort: { by: "RECOMMENDED" }, pagination: { count: 1, skip: 0 } },
  });
  const observations: RateLimitResult["observations"] = [];
  let stopped = "completed";
  for (let i = 0; i < MAX; i += 1) {
    const started = Date.now();
    try {
      const response = await fetch("https://www.royalcaribbean.com/cruises/graph", {
        method: "POST",
        headers: RC_HEADERS,
        body,
      });
      await response.text();
      observations.push({
        i,
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        rateLimitRemaining:
          response.headers.get("x-ratelimit-remaining") ??
          response.headers.get("ratelimit-remaining"),
        server: response.headers.get("server"),
        akamai: response.headers.get("akamaighost") ?? response.headers.get("server-timing"),
        elapsedMs: Date.now() - started,
      });
      if (response.status === 429 || response.status === 403) {
        stopped = `throttled-at-${i}-status-${response.status}`;
        break;
      }
    } catch (err) {
      observations.push({
        i,
        status: 0,
        retryAfter: null,
        rateLimitRemaining: null,
        server: null,
        akamai: null,
        elapsedMs: Date.now() - started,
      });
      stopped = `network-error-at-${i}: ${String(err).slice(0, 120)}`;
      break;
    }
    const elapsed = Date.now() - started;
    const wait = Math.max(0, INTERVAL_MS - elapsed);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  const throttled = observations.filter((o) => o.status === 429 || o.status === 403).length;
  const successes = observations.filter((o) => o.status === 200).length;
  return {
    capturedAt: formatISO(new Date()),
    totalRequests: observations.length,
    successes,
    throttled,
    otherFailures: observations.length - successes - throttled,
    firstThrottleAt:
      observations.findIndex((o) => o.status === 429 || o.status === 403) >= 0
        ? observations.findIndex((o) => o.status === 429 || o.status === 403)
        : null,
    observations,
    stopped,
  };
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  mkdirSync(REPLAYS_DIR, { recursive: true });
  mkdirSync(AUX_DIR, { recursive: true });

  logger.info("probing GraphQL introspection on /graph and /cruises/graph");
  const [introGraph, introCruisesGraph] = await Promise.all([
    probeIntrospection("https://www.royalcaribbean.com/graph"),
    probeIntrospection("https://www.royalcaribbean.com/cruises/graph"),
  ]);
  writeFileSync(join(OUTPUT_DIR, "introspection-graph.json"), JSON.stringify(introGraph, null, 2));
  writeFileSync(
    join(OUTPUT_DIR, "introspection-cruises-graph.json"),
    JSON.stringify(introCruisesGraph, null, 2)
  );
  logger.info(
    `introspection: /graph enabled=${introGraph.enabled}; /cruises/graph enabled=${introCruisesGraph.enabled}`
  );

  logger.info("replaying captured GraphQL operations");
  const replays = await replayCaptures();
  writeFileSync(
    join(OUTPUT_DIR, "replay-summary.json"),
    JSON.stringify(
      {
        capturedAt: formatISO(new Date()),
        total: replays.length,
        ok: replays.filter((r) => r.ok).length,
        replays,
      },
      null,
      2
    )
  );
  logger.info(`replays: ${replays.filter((r) => r.ok).length}/${replays.length} ok`);

  logger.info("fetching aux endpoints");
  const auxResults = await probeAux();
  writeFileSync(
    join(OUTPUT_DIR, "aux-summary.json"),
    JSON.stringify({ capturedAt: formatISO(new Date()), results: auxResults }, null, 2)
  );
  logger.info(`aux: ${auxResults.filter((a) => a.ok).length}/${auxResults.length} ok`);

  logger.info("probing rate limits on /cruises/graph (60 req @ 5 rps)");
  const rate = await probeRateLimit();
  writeFileSync(join(OUTPUT_DIR, "rate-limit.json"), JSON.stringify(rate, null, 2));
  logger.info(
    `rate-limit: ${rate.successes} ok, ${rate.throttled} throttled, firstThrottleAt=${rate.firstThrottleAt}`
  );

  logger.info("recon-http complete");
}

void main().catch((err) => {
  logger.errorWithStack(err, "recon-http script threw");
  process.exit(1);
});
