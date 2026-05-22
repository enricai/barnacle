/**
 * Phase 2–3 recon: replays every capture from recon-browser.ts via plain
 * Node fetch() — no browser, no AI — to prove endpoints work standalone.
 *
 * Also runs:
 *   - GraphQL introspection probe on each unique GraphQL endpoint
 *   - Auxiliary endpoint probe: downloads static JSON fixtures (markets, currencies, etc.)
 *   - Rate-limit probe (1 → 3 → 5 rps, stops at first 429/403)
 *
 * Usage:
 *   pnpm tsx src/scripts/recon-http.ts [--captures-dir /tmp/recon/graphql]
 *
 * Outputs:
 *   /tmp/recon/replays/<filename>.json  — one replay result per unique capture
 *   /tmp/recon/aux/<basename>.json      — downloaded static fixture per auxiliary endpoint
 *   /tmp/recon/replays/rate-limit.json — rate-limit probe findings
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { toErrorMessage } from "@/lib/errors";
import { configureHttpDispatcher } from "@/lib/http";
import { getScriptLogger } from "@/lib/logging";

configureHttpDispatcher();

const logger = getScriptLogger("recon-http");

const CAPTURES_DIR = "/tmp/recon/graphql";
const REPLAYS_DIR = "/tmp/recon/replays";

/** Load-bearing headers — minimal set that proves the endpoint works standalone. */
const RC_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json, */*",
  Origin: "",
  Referer: "",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

interface Capture {
  timestamp: string;
  phase: string;
  method: string;
  url: string;
  status: number;
  requestHeaders: Record<string, string>;
  requestPostData: string | null;
  responseBody: unknown;
  operationName: string | null;
  query: string | null;
  variables: unknown;
}

interface ReplayResult {
  sourceCapture: string;
  url: string;
  method: string;
  operationName: string | null;
  requestBody: string | null;
  replayStatus: number | null;
  replayHeaders: Record<string, string>;
  replayBody: unknown;
  success: boolean;
  error: string | null;
}

interface RateLimitFinding {
  endpoint: string;
  safeRps: number | null;
  triggerStatus: number | null;
  triggerRps: number | null;
  retryAfter: string | null;
  xRateLimitHeaders: Record<string, string>;
}

function loadCaptures(dir: string): Array<{ filename: string; capture: Capture }> {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".decoded.json"))
      .sort();
  } catch {
    logger.error(`captures directory not found: ${dir}`);
    logger.error("run recon-browser.ts first");
    process.exit(1);
  }

  return files.map((filename) => {
    const raw = readFileSync(join(dir, filename), "utf8");
    return { filename, capture: JSON.parse(raw) as Capture };
  });
}

function deduplicateCaptures(
  captures: Array<{ filename: string; capture: Capture }>
): Array<{ filename: string; capture: Capture }> {
  const seen = new Set<string>();
  return captures.filter(({ capture }) => {
    const key = `${capture.url}|${capture.operationName ?? ""}|${JSON.stringify(capture.variables ?? {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function replayCapture(filename: string, capture: Capture): Promise<ReplayResult> {
  const origin = new URL(capture.url).origin;
  const headers: Record<string, string> = {
    ...RC_HEADERS,
    Origin: origin,
    Referer: `${origin}/`,
  };

  let requestBody: string | null = null;
  if (capture.operationName && capture.query) {
    requestBody = JSON.stringify({
      operationName: capture.operationName,
      query: capture.query,
      variables: capture.variables ?? {},
    });
  } else if (capture.requestPostData) {
    requestBody = capture.requestPostData;
  }

  try {
    const response = await fetch(capture.url, {
      method: capture.method,
      headers,
      body: requestBody ?? undefined,
    });

    const replayHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      replayHeaders[k] = v;
    });

    let replayBody: unknown = null;
    try {
      const text = await response.text();
      try {
        replayBody = JSON.parse(text);
      } catch {
        replayBody = text;
      }
    } catch {
      // consumed
    }

    const success = response.status >= 200 && response.status < 300;

    if (!success) {
      logger.warn(`[${response.status}] ${capture.method} ${capture.url}`);
      if (response.status === 403)
        logger.warn(
          "  → 403: try adding more headers; if persistent, accept Stagehand-only production"
        );
      if (response.status === 401)
        logger.warn(
          "  → 401: endpoint requires auth — capture token, determine lifetime, build refresh strategy"
        );
    } else {
      const bodyStr = JSON.stringify(replayBody);
      if (bodyStr === "{}" || bodyStr === "[]" || bodyStr === "null")
        logger.warn(
          `[${response.status}] ${capture.method} ${capture.url} (empty body — check Origin/Referer)`
        );
      else logger.info(`[${response.status}] ${capture.method} ${capture.url}`);
    }

    return {
      sourceCapture: filename,
      url: capture.url,
      method: capture.method,
      operationName: capture.operationName,
      requestBody,
      replayStatus: response.status,
      replayHeaders,
      replayBody,
      success,
      error: null,
    };
  } catch (err) {
    logger.error(`[ERR] ${capture.method} ${capture.url}: ${toErrorMessage(err)}`);
    return {
      sourceCapture: filename,
      url: capture.url,
      method: capture.method,
      operationName: capture.operationName,
      requestBody,
      replayStatus: null,
      replayHeaders: {},
      replayBody: null,
      success: false,
      error: toErrorMessage(err),
    };
  }
}

async function probeIntrospection(endpoint: string): Promise<void> {
  logger.info(`introspection probe: ${endpoint}`);
  const origin = new URL(endpoint).origin;
  const headers: Record<string, string> = {
    ...RC_HEADERS,
    Origin: origin,
    Referer: `${origin}/`,
  };
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "{ __schema { types { name } } }" }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (body.data) {
      logger.info("  → introspection ENABLED — full schema available");
      writeFileSync(join(REPLAYS_DIR, "introspection-schema.json"), JSON.stringify(body, null, 2));
    } else {
      logger.info("  → introspection DISABLED — write Zod schemas by hand from captured JSON");
    }
  } catch (err) {
    logger.error(`  → introspection error: ${toErrorMessage(err)}`);
  }
}

const AUX_DIR = "/tmp/recon/aux";

/**
 * Finds static JSON endpoints in successful replays (markets, currencies,
 * labels, dictionaries, config) and downloads them as committed fixtures.
 * These rarely change and are cheaper to serve from a snapshot than to
 * re-fetch on every production call.
 */
async function probeAuxiliaryEndpoints(replays: ReplayResult[]): Promise<void> {
  mkdirSync(AUX_DIR, { recursive: true });
  const writtenInRun = new Set<string>();

  const candidates = replays.filter((r) => {
    if (!r.success || r.operationName !== null) return false;
    try {
      const pathname = new URL(r.url).pathname.toLowerCase();
      return (
        pathname.endsWith(".json") ||
        /\/(markets|currencies|labels|dictionaries|config|locales|i18n)/.test(pathname)
      );
    } catch {
      return false;
    }
  });

  if (candidates.length === 0) {
    logger.info("no auxiliary endpoints detected");
    return;
  }

  for (const candidate of candidates) {
    const origin = new URL(candidate.url).origin;
    const headers: Record<string, string> = {
      ...RC_HEADERS,
      Origin: origin,
      Referer: `${origin}/`,
    };
    try {
      const response = await fetch(candidate.url, { method: candidate.method, headers });
      if (!response.ok) {
        logger.warn(`[aux skip] ${candidate.url}: ${response.status} — not a fixture`);
        continue;
      }
      const body = (await response.json()) as unknown;
      const parsed = new URL(candidate.url);
      const rawBase = parsed.pathname.split("/").pop() ?? "aux";
      const base = rawBase.endsWith(".json") ? rawBase : `${rawBase}.json`;
      const filename = writtenInRun.has(base) ? `${parsed.hostname}-${base}` : base;
      writeFileSync(join(AUX_DIR, filename), JSON.stringify(body, null, 2));
      writtenInRun.add(base);
      logger.info(`[fixture] ${candidate.url} → ${AUX_DIR}/${filename} — commit as static fixture`);
    } catch (err) {
      logger.error(`[aux err] ${candidate.url}: ${toErrorMessage(err)}`);
    }
  }
}

async function probeRateLimit(
  endpoint: string,
  method: string,
  body: string | null
): Promise<RateLimitFinding> {
  logger.info(`rate-limit probe: ${endpoint} (1→3→5 rps, stops at 429/403)`);
  const origin = new URL(endpoint).origin;
  const headers: Record<string, string> = {
    ...RC_HEADERS,
    Origin: origin,
    Referer: `${origin}/`,
  };

  const finding: RateLimitFinding = {
    endpoint,
    safeRps: null,
    triggerStatus: null,
    triggerRps: null,
    retryAfter: null,
    xRateLimitHeaders: {},
  };

  const rpsCeilings = [1, 3, 5];
  const requestsPerLevel = 20;

  for (const rps of rpsCeilings) {
    const delayMs = Math.floor(1000 / rps);
    let triggered = false;

    for (let i = 0; i < requestsPerLevel; i++) {
      const before = Date.now();
      try {
        const response = await fetch(endpoint, {
          method,
          headers,
          body: body ?? undefined,
        });

        const respHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          const kl = k.toLowerCase();
          if (
            kl.startsWith("x-ratelimit") ||
            kl === "retry-after" ||
            kl.startsWith("akamai") ||
            kl.startsWith("cf-")
          ) {
            respHeaders[k] = v;
          }
        });

        if (Object.keys(respHeaders).length > 0) {
          finding.xRateLimitHeaders = { ...finding.xRateLimitHeaders, ...respHeaders };
        }

        if (response.status === 429 || response.status === 403) {
          finding.triggerStatus = response.status;
          finding.triggerRps = rps;
          finding.retryAfter = response.headers.get("retry-after");
          triggered = true;
          logger.warn(
            `  → triggered ${response.status} at ${rps} rps (request ${i + 1}/${requestsPerLevel})`
          );
          break;
        }
      } catch {
        // network error — keep going
      }

      const elapsed = Date.now() - before;
      const wait = Math.max(0, delayMs - elapsed);
      if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    }

    if (triggered) break;
    finding.safeRps = rps;
    logger.info(`  → ${rps} rps: no trigger over ${requestsPerLevel} requests`);
  }

  if (finding.triggerRps !== null) {
    finding.safeRps = rpsCeilings[rpsCeilings.indexOf(finding.triggerRps) - 1] ?? null;
    logger.info(
      `  → safe ceiling: ${finding.safeRps ?? "unknown"} rps (triggered at ${finding.triggerRps} rps)`
    );
  }

  return finding;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let capturesDir = CAPTURES_DIR;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--captures-dir" && args[i + 1]) capturesDir = args[++i]!;
  }

  mkdirSync(REPLAYS_DIR, { recursive: true });

  logger.info("=== PHASE 2: HTTP REPLAY ===");
  const all = loadCaptures(capturesDir);
  const unique = deduplicateCaptures(all);
  logger.info(`found ${all.length} captures, ${unique.length} unique`);

  const replays: ReplayResult[] = [];
  for (const { filename, capture } of unique) {
    const result = await replayCapture(filename, capture);
    replays.push(result);
    writeFileSync(join(REPLAYS_DIR, filename), JSON.stringify(result, null, 2));
  }

  const passed = replays.filter((r) => r.success).length;
  logger.info(`replay complete: ${passed}/${replays.length} passed`);

  // GraphQL introspection probe
  logger.info("=== PHASE 3A: INTROSPECTION PROBE ===");
  const graphqlEndpoints = new Set(
    replays
      .filter((r) => r.operationName !== null)
      .map((r) => {
        try {
          const u = new URL(r.url);
          return `${u.origin}${u.pathname}`;
        } catch {
          return r.url;
        }
      })
  );
  if (graphqlEndpoints.size === 0) {
    logger.info("no GraphQL endpoints found in captures");
  }
  for (const endpoint of graphqlEndpoints) {
    await probeIntrospection(endpoint);
  }

  // Auxiliary endpoint probe
  logger.info("=== PHASE 3B: AUXILIARY ENDPOINTS ===");
  await probeAuxiliaryEndpoints(replays);

  // Rate-limit probe — runs last
  logger.info("=== PHASE 3C: RATE-LIMIT PROBE (runs last — may trigger ban) ===");
  const probeTargets = new Map<string, { method: string; body: string | null }>();
  for (const replay of replays) {
    if (!replay.success) continue;
    try {
      const u = new URL(replay.url);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      const pathname = u.pathname.toLowerCase();
      // Skip static fixture endpoints — probing them 60+ times could ban the CDN egress IP
      if (
        pathname.endsWith(".json") ||
        /\/(markets|currencies|labels|dictionaries|config|locales|i18n)/.test(pathname)
      )
        continue;
      const key = `${u.origin}${u.pathname}`;
      if (!probeTargets.has(key)) {
        probeTargets.set(key, { method: replay.method, body: replay.requestBody });
      }
    } catch {
      // skip unparseable urls
    }
  }

  const rateLimitFindings: RateLimitFinding[] = [];
  for (const [endpoint, { method, body }] of probeTargets) {
    const finding = await probeRateLimit(endpoint, method, body);
    rateLimitFindings.push(finding);
  }

  writeFileSync(join(REPLAYS_DIR, "rate-limit.json"), JSON.stringify(rateLimitFindings, null, 2));

  logger.info(`recon-http complete — replays in ${REPLAYS_DIR}`);
}

main().catch((err) => {
  logger.error(`recon-http failed: ${toErrorMessage(err)}`);
  process.exit(1);
});
