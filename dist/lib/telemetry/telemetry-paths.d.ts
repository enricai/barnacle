/**
 * Path helpers for per-site, per-URL telemetry partitioning. Lets each site's
 * recon flow accumulate its LLM call corpus next to the flow file itself
 * (durable as part of the site definition) rather than into a single global
 * sink. The per-URL directory name keeps one URL's history isolated from
 * another's, so cross-run pattern analysis on a specific target stays clean.
 */
/**
 * Canonicalize a URL so trivially-different forms of the same target
 * (query-param reorderings, trailing slashes, scheme case) collapse to the
 * same identity. Query parameters are dropped entirely because the sites in
 * the current corpus identify targets by path, not by query state.
 */
export declare function canonicalizeUrl(rawUrl: string): string;
/**
 * Filesystem-safe directory name for a URL using the form
 * `<unix-ms-timestamp>-<short-hash>`. The timestamp makes `ls runs/` sort
 * chronologically by default. The hash (first 8 hex chars of SHA-1 over
 * the canonical URL) gives URL-deterministic identity, so multiple runs of
 * the same target can be grouped with `awk -F- '{print $NF}' | sort | uniq -c`
 * without consulting any sidecar.
 *
 * Why a caller-supplied timestamp instead of `Date.now()` inline: two
 * helpers below (`resolveRunCallsPath`, `resolveRunUrlPath`) need to agree
 * on the same directory within a single run, so the caller captures
 * `Date.now()` once at run-start and threads it through both calls. Same
 * `(timestampMs, rawUrl)` always yields the same dirName — deterministic.
 *
 * The `url.txt` sidecar continues to carry the authoritative URL; the hash
 * is not reversed in any current consumer.
 */
export declare function urlDirName(timestampMs: number, rawUrl: string): string;
/**
 * Resolve the per-site telemetry directory from the flow file path. Returns
 * null when no flow file was supplied (inline --flow mode, where there's no
 * durable home for the data) so the caller can short-circuit to a no-op sink.
 */
export declare function resolveSiteTelemetryDir(flowFile: string | null): string | null;
/**
 * Per-URL `calls.ndjson` sink path within a site telemetry directory.
 * `timestampMs` is the run-start timestamp captured once by the caller so
 * sibling calls (`resolveRunUrlPath`) land in the same directory.
 */
export declare function resolveRunCallsPath(siteTelemetryDir: string, timestampMs: number, rawUrl: string): string;
/**
 * Per-URL `url.txt` companion path. The directory name is `<ts>-<hash>`;
 * the sidecar carries the original URL so any engineer browsing the
 * telemetry tree sees the URL without needing to recover it from the hash.
 */
export declare function resolveRunUrlPath(siteTelemetryDir: string, timestampMs: number, rawUrl: string): string;
/**
 * Concatenate every `runs/<urlDirName>/calls.ndjson` under the site telemetry
 * directory into a single NDJSON string. Used when a consumer needs the
 * site's full call history (cross-URL pattern analysis) rather than a single
 * URL's slice. Returns empty string when the directory doesn't exist yet —
 * the caller treats that the same as "no telemetry recorded."
 */
export declare function readSiteCallsNdjson(siteTelemetryDir: string): string;
