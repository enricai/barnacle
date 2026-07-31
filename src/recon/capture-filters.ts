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
