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
 *   pnpm tsx src/scripts/recon-http.ts [--captures-dir <path>] [--out-dir <path>] [--flow-file <path>] [--methods GET,HEAD] [--include-unsafe-methods]
 *
 * Probes and replays stay on the flow's own backend: when `--flow-file` declares
 * `ownBackendHostnames`, only those hosts are replayed/rate-limit probed (without
 * it, the first captured host's registrable domain is the fallback). Loopback and
 * link-local hosts are never probed. State-changing (non-idempotent) captures are
 * replayed only with the explicit opt-in `--include-unsafe-methods`.
 *
 * `--flow-file` supplies the flow's `ownBackendHostnames` (same file
 * recon-browser.ts's own `--flow-file` reads) so the auxiliary-endpoint probe
 * (Phase 3b) only harvests the site's own static-JSON fixtures, not
 * third-party vendor config that happens to share the same path shape.
 *
 * Output lands under the run-scoped root resolved by `resolveReconRunDir()`
 * (`@/scripts/recon-shared`) — `/tmp/recon/<runId>/` by default, rooted
 * elsewhere via `--out-dir <path>` / `RECON_OUT_DIR`; `--run-dir <path>` replays an existing run:
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
import {
  isAllowedFixtureHost,
  isNoiseUrl,
  isRawCaptureFilename,
  noiseReason,
  registrableDomain,
} from "@/recon/capture-filters";
import { isSafeToReplay, unsafeReplayReason } from "@/recon/replay-safety";
import { matchingDisallow, parseRobots, type RobotsRule } from "@/recon/robots";
import { REQUEST_BODY_UNAVAILABLE } from "@/scraper/request-body-marker";
import {
  adoptReconRunRoot,
  type ReplayResult,
  readOwnBackendHostnames,
  replayPassed,
  resolveLatestReconRunRoot,
} from "@/scripts/recon-shared";

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

export type { ReplayResult };

interface RateLimitFinding {
  endpoint: string;
  safeRps: number | null;
  triggerStatus: number | null;
  triggerRps: number | null;
  retryAfter: string | null;
  xRateLimitHeaders: Record<string, string>;
}

/** Per-file host provenance record for aux fixtures, so a stale directory's origin stays checkable independent of when it was written. */
interface AuxManifestEntry {
  filename: string;
  url: string;
  hostname: string;
}

function loadCaptures(dir: string): Array<{ filename: string; capture: Capture }> {
  let files: string[];
  try {
    files = readdirSync(dir).filter(isRawCaptureFilename).sort();
  } catch {
    logger.error(`captures directory not found: ${dir}`);
    logger.error("run recon-browser.ts first");
    process.exit(1);
  }

  return files.map((filename) => {
    const raw = readFileSync(join(dir, filename), "utf8");
    const capture = JSON.parse(raw) as Capture;
    // Legacy archives can persist `query`/`operationName` as non-strings; coerce
    // at this read boundary so a stray object doesn't get replayed as a GraphQL
    // query body (see recon-shared.ts readCaptureDir for the same guard).
    return {
      filename,
      capture: {
        ...capture,
        query: typeof capture.query === "string" ? capture.query : null,
        operationName: typeof capture.operationName === "string" ? capture.operationName : null,
      },
    };
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

/** Parses a comma-separated `--methods` value (e.g. "GET,HEAD") into an upper-cased set; null = no filter. */
export function parseMethodsFilter(raw: string | undefined): Set<string> | null {
  const parts = (raw ?? "")
    .split(",")
    .map((m) => m.trim().toUpperCase())
    .filter((m) => m.length > 0);
  return parts.length > 0 ? new Set(parts) : null;
}

/** Parses a JSON body (string or value); undefined when unparseable. */
function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Collects nested key paths (arrays by first element, depth-capped) into out. */
function collectKeyPaths(v: unknown, prefix: string, depth: number, out: Set<string>): void {
  if (Array.isArray(v)) v = v[0];
  if (!v || typeof v !== "object" || depth > 6) return;
  for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.add(path);
    collectKeyPaths(child, path, depth + 1, out);
  }
}

/** Sorted nested key-path set of a JSON body; null when keyless. */
function keyShape(body: unknown): string[] | null {
  const v = parseBody(body);
  const first = Array.isArray(v) ? v[0] : v;
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;
  const out = new Set<string>();
  collectKeyPaths(first, "", 0, out);
  return [...out].sort();
}

/** True when both bodies have key shapes (compared recursively) and those differ. */
export function responseShapeDiffers(captured: unknown, replayed: unknown): boolean {
  const a = keyShape(captured);
  const b = keyShape(replayed);
  if (!a || !b) return false;
  return a.length !== b.length || a.some((k, i) => k !== b[i]);
}

/** Captured request header names (lowercased) the replay did not send. */
export function omittedHeaders(
  captured: Record<string, string> | undefined,
  sent: Record<string, string>
): string[] {
  const have = new Set(Object.keys(sent).map((k) => k.toLowerCase()));
  return Object.keys(captured ?? {})
    .map((k) => k.toLowerCase())
    .filter((k) => !have.has(k));
}

/**
 * Replays one capture. Returns null (and sends nothing) when the capture is
 * skipped: its body was recorded as the `<unavailable>` marker (replaying it
 * would send the marker literally or a body-less request), or its method is
 * excluded by `opts.methods`.
 */
export async function replayCapture(
  filename: string,
  capture: Capture,
  opts: { methods?: Set<string> | null } = {}
): Promise<ReplayResult | null> {
  if (capture.requestPostData === REQUEST_BODY_UNAVAILABLE) {
    logger.warn(`skip ${capture.method} ${capture.url}: request body unavailable at capture time`);
    return null;
  }
  if (opts.methods && !opts.methods.has(capture.method.toUpperCase())) {
    logger.info(`skip ${capture.method} ${capture.url}: method not in --methods filter`);
    return null;
  }
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
  } else if (capture.requestPostData && capture.requestPostData !== REQUEST_BODY_UNAVAILABLE) {
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

    const statusOk = response.status >= 200 && response.status < 300;
    const shapeDiffers = statusOk && responseShapeDiffers(capture.responseBody, replayBody);
    const omittedCaptureHeaders = omittedHeaders(capture.requestHeaders, headers);
    // success stays the transport verdict so rate-limit/aux-fixture consumers keep
    // their inputs; shape divergence is carried in shapeDiffers (see replayPassed).
    const success = statusOk;

    if (shapeDiffers) {
      logger.warn(
        `[${response.status}] ${capture.method} ${capture.url} response shape differs from the browser capture; a request header may be load-bearing: ${omittedCaptureHeaders.join(", ") || "(none omitted)"}`
      );
    } else if (!success) {
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
      shapeDiffers,
      omittedCaptureHeaders,
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
 * Segment-anchored static-fixture path shape, shared by the aux-fixture
 * selector and the rate-limit target selector. A bare `.json` suffix is NOT
 * enough — real REST endpoints end in `.json` too.
 */
export function isStaticFixturePath(pathname: string, includeLocaleDictionaries = false): boolean {
  const segs = includeLocaleDictionaries
    ? "markets|currencies|labels|config|dictionaries|locales|i18n"
    : "markets|currencies|labels|config";
  return new RegExp(`/(${segs})(/|\\.json$|$)`).test(pathname.toLowerCase());
}

function isReplayResultSafe(r: ReplayResult): boolean {
  let query: string | null = null;
  if (r.requestBody) {
    try {
      const b = JSON.parse(r.requestBody) as { query?: unknown };
      if (typeof b?.query === "string") query = b.query;
    } catch {
      // non-JSON body
    }
  }
  return isSafeToReplay({
    method: r.method,
    query,
    operationName: r.operationName,
  });
}

/**
 * Builds the aux-fixture candidate set from replay results. A candidate must
 * be path-shaped like genuine static reference data (markets/currencies/
 * labels/config), must not be `isNoiseUrl` noise (defense-in-depth,
 * mirroring `selectRateLimitTargets` — this function must not trust that
 * `replays` was pre-filtered by the caller), and must resolve to one of the
 * flow's declared `ownBackendHostnames`. When the flow declares none, it
 * falls back to same-registrable-domain as `fallbackHost` (the run's own
 * replayed traffic) so an undeclared flow doesn't silently harvest nothing —
 * but still excludes every other third-party host that happens to serve
 * static-JSON-shaped paths (analytics/survey/pixel vendor config). A bare
 * `.json` extension is deliberately NOT sufficient on its own: locale/i18n
 * dictionary endpoints and feature-flag resolver endpoints are own-host and
 * `.json`-shaped too, but they are per-request/per-session state, not static
 * reference data, so they must not be harvested as fixtures.
 */
export function selectAuxFixtureCandidates(
  replays: ReplayResult[],
  ownBackendHostnames: string[],
  fallbackHost: string | null
): ReplayResult[] {
  const fallbackDomain = fallbackHost ? registrableDomain(fallbackHost) : null;

  return replays.filter((r) => {
    if (!r.success || r.operationName !== null) return false;
    if (isNoiseUrl(r.url)) return false;
    let parsed: URL;
    try {
      parsed = new URL(r.url);
    } catch {
      return false;
    }
    const pathname = parsed.pathname.toLowerCase();
    if (!isStaticFixturePath(pathname)) return false;
    return isAllowedFixtureHost(parsed.hostname, ownBackendHostnames, fallbackDomain);
  });
}

/**
 * Finds static JSON endpoints in successful replays (markets, currencies,
 * labels, dictionaries, config) and downloads them as committed fixtures.
 * These rarely change and are cheaper to serve from a snapshot than to
 * re-fetch on every production call.
 */
export async function probeAuxiliaryEndpoints(
  replays: ReplayResult[],
  auxDir: string,
  ownBackendHostnames: string[],
  fallbackHost: string | null
): Promise<void> {
  mkdirSync(auxDir, { recursive: true });
  const writtenInRun = new Set<string>();
  const manifestEntries: AuxManifestEntry[] = [];

  const candidates = selectAuxFixtureCandidates(replays, ownBackendHostnames, fallbackHost);

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
      const response = await fetch(candidate.url, {
        method: candidate.method,
        headers,
      });
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
      manifestEntries.push({
        filename,
        url: candidate.url,
        hostname: parsed.hostname,
      });
      logger.info(`[fixture] ${candidate.url} → ${auxDir}/${filename} — commit as static fixture`);
    } catch (err) {
      logger.error(`[aux err] ${candidate.url}: ${toErrorMessage(err)}`);
    }
  }

  if (manifestEntries.length > 0) {
    writeFileSync(join(auxDir, "aux-manifest.json"), JSON.stringify(manifestEntries, null, 2));
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
          finding.xRateLimitHeaders = {
            ...finding.xRateLimitHeaders,
            ...respHeaders,
          };
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
 * earlier in the pipeline — the probe fires 60 requests per target, so a noise host reaching
 * this function must never silently slip through on a caller's say-so.
 */
export function isLoopbackOrLinkLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "::" || h.startsWith("fe80:")) return true;
  if (/^127\./.test(h) || /^169\.254\./.test(h) || h === "0.0.0.0") return true;
  return /^::ffff:(127\.|169\.254\.)/.test(h);
}

/**
 * True when `url` is a non-loopback host inside the flow's own backend scope.
 * Declared own hostnames match their subdomains too (`api.example.com` is in
 * scope for a declared `example.com`) because the rate-limit budget being
 * measured belongs to the site's backend as a whole, not one hostname — but the
 * match is anchored on a dot boundary so a suffix-spoofing third party
 * (`example.com.evil.example.org`) stays out. With neither own hostnames nor a
 * fallback host known, scope is unknowable and nothing is in it: this gate
 * fails closed rather than probing every captured host.
 */
export function isOwnBackendTarget(
  url: string,
  ownBackendHostnames: string[],
  fallbackHost: string | null
): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (isLoopbackOrLinkLocalHost(host)) return false;
    const own = ownBackendHostnames.map((h) => h.toLowerCase());
    if (own.length > 0) return own.some((o) => host === o || host.endsWith(`.${o}`));
    const fallbackDomain = fallbackHost ? registrableDomain(fallbackHost) : null;
    return fallbackDomain !== null && registrableDomain(host) === fallbackDomain;
  } catch {
    return false;
  }
}

export function selectRateLimitTargets(
  replays: ReplayResult[],
  ownBackendHostnames: string[],
  fallbackHost: string | null = null
): {
  targets: Map<string, { method: string; body: string | null }>;
  skipped: number;
} {
  const targets = new Map<string, { method: string; body: string | null }>();
  const seenEndpoints = new Set<string>();
  let skipped = 0;
  for (const replay of replays) {
    if (!replay.success) continue;
    if (!isReplayResultSafe(replay)) continue;
    if (isNoiseUrl(replay.url)) {
      skipped++;
      continue;
    }
    if (!isOwnBackendTarget(replay.url, ownBackendHostnames, fallbackHost)) {
      skipped++;
      continue;
    }
    try {
      const u = new URL(replay.url);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      const pathname = u.pathname.toLowerCase();
      // Skip static fixture endpoints — probing them 60+ times could ban the CDN egress IP
      if (isStaticFixturePath(pathname, true)) continue;
      // One probe per endpoint (origin + path), but the probed URL is the
      // captured request itself: its query string selects the resource and
      // often gates the response, so probing the bare path measures a
      // different request than the one recorded.
      const endpointKey = `${u.origin}${u.pathname}`;
      if (!seenEndpoints.has(endpointKey)) {
        seenEndpoints.add(endpointKey);
        targets.set(`${endpointKey}${u.search}`, {
          method: replay.method,
          body: replay.requestBody,
        });
      }
    } catch {
      // skip unparseable urls
    }
  }
  return { targets, skipped };
}

/**
 * Chooses which captures to replay. Noise URLs (incl. non-http(s)) are always
 * skipped, with the matching rule; non-safe methods are skipped unless
 * `includeUnsafe` is set or the method is explicitly listed in `optInMethods`
 * (the `--methods` flag).
 */
export function selectReplayCaptures<T extends { filename: string; capture: Capture }>(
  captures: T[],
  includeUnsafe: boolean,
  optInMethods: Set<string> | null = null
): {
  selected: T[];
  skipped: Array<{ filename: string; url: string; reason: string }>;
} {
  const selected: T[] = [];
  const skipped: Array<{ filename: string; url: string; reason: string }> = [];
  for (const item of captures) {
    const { capture, filename } = item;
    const noise = noiseReason(capture.url);
    const optedIn = optInMethods?.has((capture.method || "GET").toUpperCase()) ?? false;
    const unsafe = includeUnsafe || optedIn ? null : unsafeReplayReason(capture);
    const reason = noise ?? unsafe;
    if (reason) skipped.push({ filename, url: capture.url, reason });
    else selected.push(item);
  }
  return { selected, skipped };
}

/** Fetches /robots.txt once per origin; missing/unreachable means no rules. */
async function fetchRobotsByOrigin(urls: string[]): Promise<Map<string, RobotsRule[]>> {
  const out = new Map<string, RobotsRule[]>();
  for (const url of urls) {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      continue;
    }
    if (out.has(origin)) continue;
    let rules: RobotsRule[] = [];
    try {
      const res = await fetch(`${origin}/robots.txt`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) rules = parseRobots(await res.text());
    } catch {
      // unreachable: no restriction
    }
    out.set(origin, rules);
  }
  return out;
}

/** Splits captures into allowed and robots-disallowed (with the rule). */
export function applyRobots<T extends { capture: Capture }>(
  items: T[],
  robots: Map<string, RobotsRule[]>
): { allowed: T[]; blocked: Array<{ url: string; rule: string }> } {
  const allowed: T[] = [];
  const blocked: Array<{ url: string; rule: string }> = [];
  for (const item of items) {
    let rule: string | null = null;
    try {
      const u = new URL(item.capture.url);
      rule = matchingDisallow(robots.get(u.origin) ?? [], u.pathname + u.search);
    } catch {
      // unparseable URL: leave to existing handling
    }
    if (rule) blocked.push({ url: item.capture.url, rule });
    else allowed.push(item);
  }
  return { allowed, blocked };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let runDirArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out-dir" && args[i + 1]) process.env.RECON_OUT_DIR = args[++i]!;
    else if (args[i] === "--run-dir" && args[i + 1]) runDirArg = args[++i]!;
  }

  // recon-http replays what an earlier recon-browser run captured, so it reads
  // that run (--run-dir, RECON_RUN_ID, else the newest) rather than minting a
  // fresh empty run dir with nothing to replay.
  const runDir = adoptReconRunRoot(resolveLatestReconRunRoot(runDirArg));
  let capturesDir = runDir.graphqlDir;
  let flowFile: string | null = null;
  let methods: Set<string> | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--captures-dir" && args[i + 1]) capturesDir = args[++i]!;
    else if (args[i] === "--methods" && args[i + 1]) methods = parseMethodsFilter(args[++i]);
    else if (args[i] === "--flow-file" && args[i + 1]) flowFile = args[++i]!;
  }
  const ownBackendHostnames = flowFile ? readOwnBackendHostnames(flowFile) : [];

  mkdirSync(runDir.replaysDir, { recursive: true });

  logger.info("=== PHASE 2: HTTP REPLAY ===");
  const all = loadCaptures(capturesDir);
  if (all.length === 0) {
    logger.error(
      `recon-http: ${capturesDir} has no captures — nothing to replay (did recon-browser run first? pass --run-dir <path> to pick a run)`
    );
    process.exit(1);
  }
  const unique = deduplicateCaptures(all);
  // Drop third-party asset/telemetry hosts and a site's own error sink before
  // replaying. Without this the probe replays and rate-limits every captured
  // host — burning hours on clicktale/adsrvr/tiktok — and never reaches the one
  // endpoint that matters. The count is logged so a skipped endpoint is never
  // silently mistaken for "nothing captured it."
  const includeUnsafe = args.includes("--include-unsafe-methods");
  const { selected: preRobots, skipped } = selectReplayCaptures(unique, includeUnsafe, methods);
  const robots = await fetchRobotsByOrigin(preRobots.map((p) => p.capture.url));
  const { allowed: robotsAllowed, blocked } = applyRobots(preRobots, robots);
  const scopeHost = ((): string | null => {
    try {
      return robotsAllowed[0] ? new URL(robotsAllowed[0].capture.url).hostname : null;
    } catch {
      return null;
    }
  })();
  const probeworthy = robotsAllowed.filter(({ capture }) => {
    const ok = isOwnBackendTarget(capture.url, ownBackendHostnames, scopeHost);
    if (!ok) logger.info(`skipped ${capture.url}: outside own-backend scope or loopback`);
    return ok;
  });
  for (const b of blocked) logger.info(`skipped ${b.url}: robots.txt Disallow: ${b.rule}`);
  logger.info(
    `found ${all.length} captures, ${unique.length} unique, ${probeworthy.length} probeworthy` +
      (skipped.length > 0 ? ` (${skipped.length} skipped)` : "")
  );
  for (const sk of skipped) logger.info(`skipped ${sk.url}: ${sk.reason}`);

  const replays: ReplayResult[] = [];
  for (const { filename, capture } of probeworthy) {
    const result = await replayCapture(filename, capture, { methods });
    if (result === null) continue;
    replays.push(result);
    writeFileSync(join(runDir.replaysDir, filename), JSON.stringify(result, null, 2));
  }

  const passed = replays.filter(replayPassed).length;
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

  // Auxiliary endpoint probe. When the flow declares no ownBackendHostnames,
  // fall back to the registrable domain of the first probeworthy replay's
  // host — `replays` is already the post-isNoiseUrl-filtered set built above,
  // so it's a safe same-site proxy.
  logger.info("=== PHASE 3B: AUXILIARY ENDPOINTS ===");
  const fallbackHost = ((): string | null => {
    try {
      return replays[0] ? new URL(replays[0].url).hostname : null;
    } catch {
      return null;
    }
  })();
  await probeAuxiliaryEndpoints(replays, runDir.auxDir, ownBackendHostnames, fallbackHost);

  // Rate-limit probe — runs last
  logger.info("=== PHASE 3C: RATE-LIMIT PROBE (runs last — may trigger ban) ===");
  const { targets: probeTargets, skipped: skippedAsNoise } = selectRateLimitTargets(
    replays,
    ownBackendHostnames,
    fallbackHost
  );
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

if (
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("recon-http.ts") || process.argv[1].endsWith("recon-http.js"))
) {
  main().catch((err) => {
    logger.error(`recon-http failed: ${toErrorMessage(err)}`);
    process.exit(1);
  });
}
