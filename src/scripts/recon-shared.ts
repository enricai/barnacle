/**
 * Shared types and utilities for the recon pipeline scripts.
 * Extracted so recon-summarize.ts and recon-generate.ts stay consistent
 * without duplicating the core data model or header-tally logic.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { format } from "date-fns";

import { getScriptLogger } from "@/lib/logging";

const logger = getScriptLogger("recon-shared");

/**
 * Legacy process-global paths, kept exported for back-compat since
 * `recon-shared` is a published package subpath. New callers should use
 * {@link resolveReconRunDir} instead — these do not get per-run namespacing.
 */
export const CAPTURES_DIR = "/tmp/recon/graphql";
export const REPLAYS_DIR = "/tmp/recon/replays";
export const AUX_DIR = "/tmp/recon/aux";
export const STEP_FAILURES_DIR = "/tmp/recon/step-failures";
export const COOKIES_DIR = "/tmp/recon/cookies";

/** Subdirectory names created under every resolved recon run root. */
const RUN_SUBDIRS = ["graphql", "cookies", "replays", "aux", "step-failures"] as const;

export interface ReconRunDir {
  runId: string;
  root: string;
  graphqlDir: string;
  cookiesDir: string;
  replaysDir: string;
  auxDir: string;
  stepFailuresDir: string;
}

/** Memoized so repeated calls within one process share a single run root and runId. */
let memoizedRunDir: ReconRunDir | null = null;

function generateRunId(): string {
  const timestamp = format(new Date(), "yyyyMMdd-HHmmss");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 4);
  return `${timestamp}-${suffix}`;
}

/**
 * Resolves (and creates) the run-scoped root directory recon scripts should
 * write output under, namespacing every run so concurrent or repeated runs
 * stop silently colliding in a shared `/tmp/recon` tree. Memoized per
 * process so a run's counter-based filenames stay in one namespace across
 * every call site.
 *
 * `RECON_RUN_ID` pins a deterministic runId (e.g. for tests or replays of a
 * known run); `RECON_OUT_DIR` overrides the base directory runs are rooted
 * under (default `/tmp/recon`).
 */
export function resolveReconRunDir(): ReconRunDir {
  if (memoizedRunDir) {
    return memoizedRunDir;
  }

  const runId = process.env.RECON_RUN_ID || generateRunId();
  const baseDir = process.env.RECON_OUT_DIR || "/tmp/recon";
  const root = join(baseDir, runId);

  const runDir: ReconRunDir = {
    runId,
    root,
    graphqlDir: join(root, "graphql"),
    cookiesDir: join(root, "cookies"),
    replaysDir: join(root, "replays"),
    auxDir: join(root, "aux"),
    stepFailuresDir: join(root, "step-failures"),
  };

  for (const subdir of RUN_SUBDIRS) {
    mkdirSync(join(root, subdir), { recursive: true });
  }

  logger.info(`resolved recon run dir: runId=${runId}, root=${root}`);
  memoizedRunDir = runDir;
  return memoizedRunDir;
}

export interface Capture {
  timestamp: string;
  phase: string;
  method: string;
  url: string;
  status: number;
  requestHeaders: Record<string, string>;
  requestPostData: string | null;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  operationName: string | null;
  query: string | null;
  variables: unknown;
  decodedParams: unknown;
}

/**
 * A single cookie as reported by CDP's Network.getAllCookies. Field names and
 * types mirror the CDP Network.Cookie type verbatim so no lossy remap step is
 * needed between capture and disk. `expires` stays the raw CDP number
 * (-1 for session cookies) — readers format it, not this layer.
 */
export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite: "Strict" | "Lax" | "None" | null;
}

/**
 * The full cookie jar at one phase of a recon journey (e.g. post-click vs.
 * post-apply), so a run can show what each phase specifically established.
 * `error` is populated instead of `cookies` when the CDP call failed —
 * cookie telemetry is best-effort and must never abort the run.
 */
export interface CookieJarSnapshot {
  label: string;
  phase: string;
  stepIndex: number;
  timestamp: string;
  cookies: CookieRecord[];
  error?: string;
}

export interface ReplayResult {
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

export interface RateLimitFinding {
  endpoint: string;
  safeRps: number | null;
  triggerStatus: number | null;
  triggerRps: number | null;
  retryAfter: string | null;
  xRateLimitHeaders: Record<string, string>;
}

export function readJsonDir<T>(dir: string, exclude: string[] = []): T[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".decoded.json") && !exclude.includes(f))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as T);
  } catch {
    return [];
  }
}

/**
 * Counts how often each response header appears across successful replays.
 * Infrastructure headers that are never load-bearing on the request side are
 * excluded so the caller sees only candidates worth committing as BASE_HEADERS.
 */
export function tallyResponseHeaders(replays: ReplayResult[]): Map<string, number> {
  const IGNORE = new Set([
    "date",
    "content-length",
    "transfer-encoding",
    "connection",
    "vary",
    "server",
    "x-request-id",
    "x-correlation-id",
    "cf-ray",
    "cf-cache-status",
    "age",
    "via",
    "etag",
    "last-modified",
    "expires",
    "pragma",
    "strict-transport-security",
    "x-content-type-options",
    "x-frame-options",
    "x-xss-protection",
  ]);
  const counts = new Map<string, number>();
  const successfulReplays = replays.filter((r) => r.success && r.replayHeaders);
  for (const replay of successfulReplays) {
    for (const header of Object.keys(replay.replayHeaders)) {
      const lower = header.toLowerCase();
      if (IGNORE.has(lower)) continue;
      counts.set(lower, (counts.get(lower) ?? 0) + 1);
    }
  }
  return counts;
}
