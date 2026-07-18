/**
 * Phase 2–3 recon: replays every same-site capture from recon-browser.ts via
 * plain Node fetch() — no browser, no AI — to prove endpoints work standalone.
 * Third-party asset/telemetry hosts and a site's own error sink are filtered out
 * first (see `@/recon/capture-filters`) so the probe never burns time replaying
 * clicktale/adsrvr/tiktok chatter.
 *
 * Also runs:
 *   - GraphQL introspection probe on each unique GraphQL endpoint
 *   - Auxiliary endpoint probe: downloads static JSON fixtures (markets, currencies, etc.)
 *   - Rate-limit probe (1 → 3 → 5 rps, stops at first 429/403)
 *
 * Usage:
 *   pnpm tsx src/scripts/recon-http.ts [--captures-dir <path>] [--out-dir <path>]
 *
 * Output lands under the run-scoped root resolved by `resolveReconRunDir()`
 * (`@/scripts/recon-shared`) — `/tmp/recon/<runId>/` by default, rooted
 * elsewhere via `--out-dir <path>` / `RECON_OUT_DIR`:
 *   replays/<filename>.json  — one replay result per unique capture
 *   aux/<basename>.json      — downloaded static fixture per auxiliary endpoint
 *   replays/rate-limit.json  — rate-limit probe findings
 *
 * `--captures-dir` overrides only the *read* path for captures (e.g. to
 * replay a prior run's captures into a fresh output root) and defaults to
 * this run's own `graphqlDir`.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { toErrorMessage } from "@/lib/errors";
import { configureHttpDispatcher } from "@/lib/http";
import { getScriptLogger } from "@/lib/logging";
import { isNoiseUrl } from "@/recon/capture-filters";
import { resolveReconRunDir } from "@/scripts/recon-shared";

configureHttpDispatcher();

const logger = getScriptLogger("recon-http");

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

async function probeIntrospection(endpoint: string, replaysDir: string): Promise<void> {
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
      writeFileSync(join(replaysDir, "introspection-schema.json"), JSON.stringify(body, null, 2));
    } else {
      logger.info("  → introspection DISABLED — write Zod schemas by hand from captured JSON");
    }
  } catch (err) {
    logger.error(`  → introspection error: ${toErrorMessage(err)}`);
  }
}

/**
 * Finds static JSON endpoints in successful replays (markets, currencies,
 * labels, dictionaries, config) and downloads them as committed fixtures.
 * These rarely change and are cheaper to serve from a snapshot than to
 * re-fetch on every production call.
 */
async function probeAuxiliaryEndpoints(replays: ReplayResult[], auxDir: string): Promise<void> {
  mkdirSync(auxDir, { recursive: true });
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
      writeFileSync(join(auxDir, filename), JSON.stringify(body, null, 2));
      writtenInRun.add(base);
      logger.info(`[fixture] ${candidate.url} → ${auxDir}/${filename} — commit as static fixture`);
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

/**
 * Builds the rate-limit probe's target set from replay results. Applies
 * `isNoiseUrl` directly rather than trusting that `replays` was pre-filtered
 * upstream — the probe fires 60 requests per target, so a noise host reaching
 * this function must never silently slip through on a caller's say-so.
 */
export function selectRateLimitTargets(
  replays: ReplayResult[]
): { targets: Map<string, { method: string; body: string | null }>; skipped: number } {
  const targets = new Map<string, { method: string; body: string | null }>();
  let skipped = 0;
  for (const replay of replays) {
    if (!replay.success) continue;
    if (isNoiseUrl(replay.url)) {
      skipped++;
      continue;
    }
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
      if (!targets.has(key)) {
        targets.set(key, { method: replay.method, body: replay.requestBody });
      }
    } catch {
      // skip unparseable urls
    }
  }
  return { targets, skipped };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out-dir" && args[i + 1]) process.env.RECON_OUT_DIR = args[++i]!;
  }

  const runDir = resolveReconRunDir();
  let capturesDir = runDir.graphqlDir;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--captures-dir" && args[i + 1]) capturesDir = args[++i]!;
  }

  mkdirSync(runDir.replaysDir, { recursive: true });

  logger.info("=== PHASE 2: HTTP REPLAY ===");
  const all = loadCaptures(capturesDir);
  const unique = deduplicateCaptures(all);
  // Drop third-party asset/telemetry hosts and a site's own error sink before
  // replaying. Without this the probe replays and rate-limits every captured
  // host — burning hours on clicktale/adsrvr/tiktok — and never reaches the one
  // endpoint that matters. The count is logged so a skipped endpoint is never
  // silently mistaken for "nothing captured it."
  const probeworthy = unique.filter(({ capture }) => !isNoiseUrl(capture.url));
  const skipped = unique.length - probeworthy.length;
  logger.info(
    `found ${all.length} captures, ${unique.length} unique, ${probeworthy.length} probeworthy` +
      (skipped > 0 ? ` (${skipped} asset/telemetry/error host(s) skipped)` : "")
  );

  const replays: ReplayResult[] = [];
  for (const { filename, capture } of probeworthy) {
    const result = await replayCapture(filename, capture);
    replays.push(result);
    writeFileSync(join(runDir.replaysDir, filename), JSON.stringify(result, null, 2));
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
    await probeIntrospection(endpoint, runDir.replaysDir);
  }

  // Auxiliary endpoint probe
  logger.info("=== PHASE 3B: AUXILIARY ENDPOINTS ===");
  await probeAuxiliaryEndpoints(replays, runDir.auxDir);

  // Rate-limit probe — runs last
  logger.info("=== PHASE 3C: RATE-LIMIT PROBE (runs last — may trigger ban) ===");
  const { targets: probeTargets, skipped: skippedAsNoise } = selectRateLimitTargets(replays);
  logger.info(
    `rate-limit targets: ${probeTargets.size}` +
      (skippedAsNoise > 0 ? ` (${skippedAsNoise} skipped as noise)` : "")
  );

  const rateLimitFindings: RateLimitFinding[] = [];
  for (const [endpoint, { method, body }] of probeTargets) {
    const finding = await probeRateLimit(endpoint, method, body);
    rateLimitFindings.push(finding);
  }

  writeFileSync(
    join(runDir.replaysDir, "rate-limit.json"),
    JSON.stringify(rateLimitFindings, null, 2)
  );

  logger.info(`recon-http complete — replays in ${runDir.replaysDir}`);
}

main().catch((err) => {
  logger.error(`recon-http failed: ${toErrorMessage(err)}`);
  process.exit(1);
});
