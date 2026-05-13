/**
 * Shared types and utilities for the recon pipeline scripts.
 * Extracted so recon-summarize.ts and recon-generate.ts stay consistent
 * without duplicating the core data model or header-tally logic.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CAPTURES_DIR = "/tmp/recon/graphql";
export const REPLAYS_DIR = "/tmp/recon/replays";
export const AUX_DIR = "/tmp/recon/aux";
export const STEP_FAILURES_DIR = "/tmp/recon/step-failures";

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
