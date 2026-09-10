/**
 * Shared predicates for deciding which captured requests are the site's real
 * flow versus incidental browser noise (analytics beacons, ad-tech, a page's own
 * error-reporting sink, static assets).
 *
 * Lives outside `src/scripts/` so both the emitter (`recon-generate.ts`, which
 * must not emit noise into a generated plugin) and the HTTP probe
 * (`recon-http.ts`, which must not burn hours replaying third-party hosts) apply
 * ONE definition of "noise." Previously only the emitter filtered; the probe
 * replayed and rate-limited everything, including `clicktale`/`adsrvr`/`tiktok`.
 */

/**
 * Path/URL substrings we always treat as analytics or logging noise. Site-specific
 * trackers belong in the `RECON_TELEMETRY_URL_PATTERNS` env var (comma-separated),
 * not here — the engine must not carry any one site's ad-tech domains.
 *
 * Read at call time, not frozen at import: a module-level const would ignore an
 * env var set after load, the exact foot-gun `RECON_QUESTION_KEYWORDS` documents.
 */
export function telemetryUrlPatterns(): string[] {
  return [
    "/util/logging/vweb/message",
    "/blank/page",
    "stats.g.doubleclick.net",
    "google-analytics.com",
    ...(process.env.RECON_TELEMETRY_URL_PATTERNS ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  ];
}

/**
 * A path whose own segment is `error`/`errors` is a client-side reporting sink,
 * never a call a caller wants replayed or emitted.
 *
 * Matched on a whole path segment rather than by substring so `/error-codes` and
 * `/terrorism-screening` stay data endpoints, and kept out of the telemetry list
 * because that list is literal substrings — a site's own sink is structural, not
 * an ad-tech domain the operator must enumerate.
 */
export const ERROR_SINK_PATH_SEGMENT = /(^|\/)errors?(\/|$)/i;

/**
 * Third-party hosts recon repeatedly wastes time on: ad-tech, session replay,
 * social pixels, tag managers. A capture whose host matches is not the site's
 * own endpoint and never worth replaying or rate-limiting.
 *
 * A suffix match on the registrable-ish host substring, so `x.clicktale.net`
 * and `sync.adsrvr.org` both match. Extendable per-site via
 * `RECON_TELEMETRY_URL_PATTERNS`, which {@link isNoiseUrl} also honors.
 */
const THIRD_PARTY_ASSET_HOSTS = [
  "clicktale.net",
  "adsrvr.org",
  "tiktok.com",
  "doubleclick.net",
  "google-analytics.com",
  "googletagmanager.com",
  "facebook.net",
  "facebook.com",
  "hotjar.com",
  "segment.io",
  "segment.com",
  "fullstory.com",
  "cdn.cookielaw.org",
  "onetrust.com",
  "demdex.net",
  "omtrdc.net",
  "quantserve.com",
  "scorecardresearch.com",
];

/** Static-asset extensions a probe should never replay as an API endpoint. */
const ASSET_EXTENSION = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map)$/i;

/**
 * True when a captured URL is noise the recon pipeline should skip: a telemetry
 * pattern (including any `RECON_TELEMETRY_URL_PATTERNS` addition), a third-party
 * asset/tracking host, a same-host error-reporting sink, or a static asset.
 *
 * The one gate both the emitter and the probe consult so "what counts as the
 * site's real flow" cannot drift between them.
 */
export function isNoiseUrl(url: string): boolean {
  const patterns = telemetryUrlPatterns();
  if (patterns.some((p) => url.includes(p))) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.host.toLowerCase();
  if (THIRD_PARTY_ASSET_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  if (ERROR_SINK_PATH_SEGMENT.test(parsed.pathname)) return true;
  if (ASSET_EXTENSION.test(parsed.pathname)) return true;
  return false;
}

/**
 * Naive registrable-domain heuristic: the last two dot-separated labels. No
 * PSL library is used anywhere in this codebase (this file's own host
 * matching above is plain suffix comparison), so a hand-rolled 2-label
 * approximation is consistent style rather than a new dependency. Good
 * enough for grouping same-vendor subdomains (`api.example.com` /
 * `static.example.com` → `example.com`); not correct for multi-label
 * public suffixes (e.g. `co.uk`), which this codebase does not target.
 */
export function registrableDomain(hostname: string): string {
  const labels = hostname
    .toLowerCase()
    .split(".")
    .filter((label) => label.length > 0);
  return labels.length <= 2 ? labels.join(".") : labels.slice(-2).join(".");
}

/** Tokens too short or too generic to signal endpoint-family relatedness on their own. */
const GENERIC_PATH_TOKENS = new Set(["api", "app", "apps", "v1", "v2", "v3", "com", "get", "post"]);

/**
 * Splits a URL path into lowercase word tokens, breaking on non-alphanumeric
 * separators (`/`, `-`, `_`, `.`) and camelCase boundaries, then drops tokens
 * that are too short (<3 chars) or too generic ({@link GENERIC_PATH_TOKENS})
 * to signal endpoint-family relatedness on their own.
 *
 * Only tokens from a *compound* path segment (one that itself splits into 2+
 * words, e.g. `productavail-vas`) are kept. A whole segment that is a single
 * plain word (e.g. `search`, `list`, `detail`, `widget`) is dropped entirely:
 * such words recur across unrelated endpoint families on the same host, so
 * treating them as a relatedness signal produces false positives (a marketing
 * `/promotions/search` call "matching" a booking flow's `.../v1/search` just
 * because both happen to end in the common word "search"). Compound segments
 * are where a real endpoint-family identifier lives.
 */
function pathStructuralTokens(path: string): Set<string> {
  const words = path
    .split("/")
    .filter(Boolean)
    .flatMap((segment) => {
      const parts = segment
        .split(/[^a-zA-Z0-9]+/)
        .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
        .filter(Boolean);
      return parts.length >= 2 ? parts : [];
    })
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= 3 && !GENERIC_PATH_TOKENS.has(word));
  return new Set(words);
}

/**
 * True when `candidatePath` shares enough path-segment tokens with at least
 * one path in `referencePaths` to be judged part of the same endpoint
 * family, false when it is structurally unrelated to all of them.
 *
 * A literal prefix/substring check is too strict: real same-flow endpoint
 * families (e.g. `.../productavail-vas/...` and `.../sailingavailability-vas/...`)
 * do not share a string prefix segment-for-segment, but do share the
 * `-vas` suffix and surrounding path structure once tokenized. Token overlap
 * on segment words — ignoring short/generic tokens — catches that relation
 * while still rejecting a same-host capture that shares nothing but the
 * host (e.g. a marketing endpoint alongside a resolved booking flow).
 */
export function isStructurallyRelevantCapture(
  candidatePath: string,
  referencePaths: readonly string[]
): boolean {
  const candidateTokens = pathStructuralTokens(candidatePath);
  if (candidateTokens.size === 0) return false;
  return referencePaths.some((referencePath) => {
    const referenceTokens = pathStructuralTokens(referencePath);
    for (const token of candidateTokens) {
      if (referenceTokens.has(token)) return true;
    }
    return false;
  });
}

/**
 * True when `candidatePath` has a compound (multi-word) path segment whose
 * tokens share nothing with ANY other path in `poolPaths` — a same-host
 * capture whose own path structurally isolates it from every other member of
 * the pool it was admitted into. A plain single-word path (empty token set,
 * e.g. `/applicant`) is never flagged: most real endpoint chains are single-
 * word paths that share no tokens with each other either, so treating an
 * empty token set as isolation would flag the whole chain as noise.
 *
 * Anchored on {@link isStructurallyRelevantCapture}'s own token overlap rule
 * so "isolated" is exactly "not relevant to anything else in the pool" —
 * this is what lets a same-host marketing/promotions capture (compound path,
 * shares nothing with the rest of a resolved chain) be recognized as noise
 * even when the chain declares no `submitEndpointPattern` to anchor against,
 * unlike {@link isStructurallyRelevantCapture} which requires one.
 */
export function isStructurallyIsolatedCapture(
  candidatePath: string,
  poolPaths: readonly string[]
): boolean {
  if (pathStructuralTokens(candidatePath).size === 0) return false;
  return !isStructurallyRelevantCapture(candidatePath, poolPaths);
}

/**
 * True when `hostname` is allowed as a fixture host: an exact match against
 * `ownBackendHostnames` when the flow declares any, otherwise a
 * same-registrable-domain match against `fallbackDomain`. Shared by
 * `recon-http.ts`'s write-time filter and `recon-generate.ts`'s copy-time
 * filter so which hosts count as "the site's own backend" cannot drift
 * between capture and emission.
 */
export function isAllowedFixtureHost(
  hostname: string,
  ownBackendHostnames: string[],
  fallbackDomain: string | null
): boolean {
  const host = hostname.toLowerCase();
  const allowedHostnames = new Set(ownBackendHostnames.map((h) => h.toLowerCase()));
  if (allowedHostnames.size > 0) return allowedHostnames.has(host);
  return fallbackDomain !== null && registrableDomain(host) === fallbackDomain;
}
