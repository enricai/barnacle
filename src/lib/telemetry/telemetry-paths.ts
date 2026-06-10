/**
 * Path helpers for per-site, per-URL telemetry partitioning. Lets each site's
 * recon flow accumulate its LLM call corpus next to the flow file itself
 * (durable as part of the site definition) rather than into a single global
 * sink. The URL hash keeps one URL's history isolated from another's, so
 * cross-run pattern analysis on a specific target stays clean.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import normalizeUrl from "normalize-url";

/** Length of the hex prefix used as the per-URL partition directory name. */
const URL_HASH_HEX_LENGTH = 10;

/**
 * Canonicalize a URL before hashing so trivially-different forms of the same
 * target (query-param reorderings, trailing slashes, scheme case) hash to the
 * same partition. Query parameters are dropped entirely because the sites in
 * the current corpus identify targets by path, not by query state.
 */
export function canonicalizeUrl(rawUrl: string): string {
  return normalizeUrl(rawUrl, {
    removeQueryParameters: true,
    stripHash: true,
    stripWWW: false,
  });
}

/**
 * Stable filesystem-safe identifier for a URL. The prefix length is wide
 * enough that collisions are vanishingly unlikely across the run volume any
 * one site sees in practice.
 */
export function urlHash(rawUrl: string): string {
  const canonical = canonicalizeUrl(rawUrl);
  return createHash("sha256").update(canonical).digest("hex").slice(0, URL_HASH_HEX_LENGTH);
}

/**
 * Resolve the per-site telemetry directory from the flow file path. Returns
 * null when no flow file was supplied (inline --flow mode, where there's no
 * durable home for the data) so the caller can short-circuit to a no-op sink.
 */
export function resolveSiteTelemetryDir(flowFile: string | null): string | null {
  if (flowFile === null) return null;
  return join(dirname(flowFile), "telemetry");
}

/**
 * Per-URL `calls.ndjson` sink path within a site telemetry directory.
 */
export function resolveRunCallsPath(siteTelemetryDir: string, rawUrl: string): string {
  return join(siteTelemetryDir, "runs", urlHash(rawUrl), "calls.ndjson");
}

/**
 * Per-URL `url.txt` companion path. Makes the partition directory greppable
 * by hand when an engineer pokes around the telemetry tree.
 */
export function resolveRunUrlPath(siteTelemetryDir: string, rawUrl: string): string {
  return join(siteTelemetryDir, "runs", urlHash(rawUrl), "url.txt");
}

/**
 * Concatenate every `runs/<urlHash>/calls.ndjson` under the site telemetry
 * directory into a single NDJSON string. Used when a consumer needs the
 * site's full call history (cross-URL pattern analysis) rather than a single
 * URL's slice. Returns empty string when the directory doesn't exist yet —
 * the caller treats that the same as "no telemetry recorded."
 */
export function readSiteCallsNdjson(siteTelemetryDir: string): string {
  const runsDir = join(siteTelemetryDir, "runs");
  if (!existsSync(runsDir)) return "";
  const partitions = readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(runsDir, d.name, "calls.ndjson"))
    .filter((p) => existsSync(p));
  if (partitions.length === 0) return "";
  return partitions.map((p) => readFileSync(p, "utf8")).join("");
}
