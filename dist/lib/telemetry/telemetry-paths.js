"use strict";
/**
 * Path helpers for per-site, per-URL telemetry partitioning. Lets each site's
 * recon flow accumulate its LLM call corpus next to the flow file itself
 * (durable as part of the site definition) rather than into a single global
 * sink. The per-URL directory name keeps one URL's history isolated from
 * another's, so cross-run pattern analysis on a specific target stays clean.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.canonicalizeUrl = canonicalizeUrl;
exports.urlDirName = urlDirName;
exports.resolveSiteTelemetryDir = resolveSiteTelemetryDir;
exports.resolveRunCallsPath = resolveRunCallsPath;
exports.resolveRunUrlPath = resolveRunUrlPath;
exports.readSiteCallsNdjson = readSiteCallsNdjson;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const normalize_url_1 = __importDefault(require("normalize-url"));
/**
 * Canonicalize a URL so trivially-different forms of the same target
 * (query-param reorderings, trailing slashes, scheme case) collapse to the
 * same identity. Query parameters are dropped entirely because the sites in
 * the current corpus identify targets by path, not by query state.
 */
function canonicalizeUrl(rawUrl) {
    return (0, normalize_url_1.default)(rawUrl, {
        removeQueryParameters: true,
        stripHash: true,
        stripWWW: false,
    });
}
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
function urlDirName(timestampMs, rawUrl) {
    const canonical = canonicalizeUrl(rawUrl);
    const hash = (0, node_crypto_1.createHash)("sha1").update(canonical, "utf8").digest("hex").slice(0, 8);
    return `${timestampMs}-${hash}`;
}
/**
 * Resolve the per-site telemetry directory from the flow file path. Returns
 * null when no flow file was supplied (inline --flow mode, where there's no
 * durable home for the data) so the caller can short-circuit to a no-op sink.
 */
function resolveSiteTelemetryDir(flowFile) {
    if (flowFile === null)
        return null;
    return (0, node_path_1.join)((0, node_path_1.dirname)(flowFile), "telemetry");
}
/**
 * Per-URL `calls.ndjson` sink path within a site telemetry directory.
 * `timestampMs` is the run-start timestamp captured once by the caller so
 * sibling calls (`resolveRunUrlPath`) land in the same directory.
 */
function resolveRunCallsPath(siteTelemetryDir, timestampMs, rawUrl) {
    return (0, node_path_1.join)(siteTelemetryDir, "runs", urlDirName(timestampMs, rawUrl), "calls.ndjson");
}
/**
 * Per-URL `url.txt` companion path. The directory name is `<ts>-<hash>`;
 * the sidecar carries the original URL so any engineer browsing the
 * telemetry tree sees the URL without needing to recover it from the hash.
 */
function resolveRunUrlPath(siteTelemetryDir, timestampMs, rawUrl) {
    return (0, node_path_1.join)(siteTelemetryDir, "runs", urlDirName(timestampMs, rawUrl), "url.txt");
}
/**
 * Concatenate every `runs/<urlDirName>/calls.ndjson` under the site telemetry
 * directory into a single NDJSON string. Used when a consumer needs the
 * site's full call history (cross-URL pattern analysis) rather than a single
 * URL's slice. Returns empty string when the directory doesn't exist yet —
 * the caller treats that the same as "no telemetry recorded."
 */
function readSiteCallsNdjson(siteTelemetryDir) {
    const runsDir = (0, node_path_1.join)(siteTelemetryDir, "runs");
    if (!(0, node_fs_1.existsSync)(runsDir))
        return "";
    const partitions = (0, node_fs_1.readdirSync)(runsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => (0, node_path_1.join)(runsDir, d.name, "calls.ndjson"))
        .filter((p) => (0, node_fs_1.existsSync)(p));
    if (partitions.length === 0)
        return "";
    return partitions.map((p) => (0, node_fs_1.readFileSync)(p, "utf8")).join("");
}
//# sourceMappingURL=telemetry-paths.js.map