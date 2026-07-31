/**
 * Path helpers for per-site, per-URL telemetry partitioning. Lets each site's
 * recon flow accumulate its LLM call corpus next to the flow file itself
 * (durable as part of the site definition) rather than into a single global
 * sink. The per-URL directory name keeps one URL's history isolated from
 * another's, so cross-run pattern analysis on a specific target stays clean.
 */

import { Buffer } from "node:buffer";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import normalizeUrl from "normalize-url";

/**
 * Canonicalize a URL so trivially-different forms of the same target
 * (query-param reorderings, trailing slashes, scheme case) collapse to the
 * same identity. Query parameters are dropped entirely because the sites in
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
 * Filesystem-safe directory name for a URL. base64url is a bijection over the
 * canonical URL bytes — distinct URLs always produce distinct names, so
 * partition collisions are mathematically impossible (a property a truncated
 * cryptographic hash cannot guarantee). The encoding is also reversible, so a
 * future caller can recover the URL from the directory name without consulting
 * any sidecar file.
 */
export function urlDirName(rawUrl: string): string {
  const canonical = canonicalizeUrl(rawUrl);
  return Buffer.from(canonical, "utf8").toString("base64url");
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
  return join(siteTelemetryDir, "runs", urlDirName(rawUrl), "calls.ndjson");
}

/**
 * Per-URL `url.txt` companion path. base64url directory names round-trip
 * back to the canonical URL, but keeping the plain-text companion saves any
 * engineer browsing the telemetry tree the mental decode.
 */
export function resolveRunUrlPath(siteTelemetryDir: string, rawUrl: string): string {
  return join(siteTelemetryDir, "runs", urlDirName(rawUrl), "url.txt");
}

/**
 * Concatenate every `runs/<urlDirName>/calls.ndjson` under the site telemetry
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
