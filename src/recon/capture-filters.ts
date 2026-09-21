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
 * words, e.g. `listing-avail-vas`) are kept. A whole segment that is a single
 * plain word (e.g. `search`, `list`, `detail`, `widget`) is dropped entirely:
 * such words recur across unrelated endpoint families on the same host, so
 * treating them as a relatedness signal produces false positives (a marketing
 * `/promotions/search` call "matching" a booking flow's `.../v1/search` just
 * because both happen to end in the common word "search"). Compound segments
 * are where a real endpoint-family identifier lives.
 */
export function pathStructuralTokens(path: string): Set<string> {
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
 * Lowercased raw path segments, dropping the same short (<3 chars) and
 * generic ({@link GENERIC_PATH_TOKENS}) ones {@link pathStructuralTokens}
 * excludes from compound-segment tokens — so a raw-segment overlap check
 * can't be satisfied by two paths sharing nothing but a boilerplate `/api/`
 * or `/v1/` segment.
 */
function meaningfulPathSegments(path: string): string[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase())
    .filter((segment) => segment.length >= 3 && !GENERIC_PATH_TOKENS.has(segment));
}

/**
 * True when some meaningful segment of `path` recurs elsewhere in the same
 * path (e.g. `widget` in `/widget/api/promotions/widget/default`). Real action
 * chains name each step for what it does (`/user/profile/edit`) and so
 * rarely repeat a segment; a same-host marketing/promotions endpoint is
 * commonly self-referential — its resource identifier shows up twice in its
 * own path — which is what marks it as a templated/generated noise path
 * rather than a genuine, if short, chain step.
 */
function hasRepeatedMeaningfulSegment(path: string): boolean {
  const segments = meaningfulPathSegments(path);
  return new Set(segments).size < segments.length;
}

/**
 * True when `candidatePath` shares enough path-segment tokens with at least
 * one path in `referencePaths` to be judged part of the same endpoint
 * family, false when it is structurally unrelated to all of them.
 *
 * A literal prefix/substring check is too strict: real same-flow endpoint
 * families (e.g. `.../listing-avail-vas/...` and `.../item-detail-vas/...`)
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
 * the pool it was admitted into.
 *
 * A path with no compound segment (empty token set) falls back to a raw
 * segment-overlap check instead of an automatic pass, but only when the path
 * has a {@link hasRepeatedMeaningfulSegment repeated segment} of its own
 * (e.g. `widget` recurring in `/widget/api/promotions/widget/default`): a chain's
 * own steps are plain-word paths that name a distinct action per step
 * (`/applicant`, `/sections/name`, or a 3-segment `/user/profile/edit`) and
 * so essentially never repeat a segment against themselves, even when they
 * share no tokens — or even raw segments — with sibling steps (e.g. a real
 * `create` -> `sections/name` -> `submit` sequence, none of whose plain-word
 * steps share a segment with either of the others). A same-host
 * marketing/promotions capture is commonly self-referential — its own
 * resource identifier shows up twice in its own path — which is the signal
 * that marks it as a templated/generated noise path rather than a genuine
 * short (or not-so-short) single-word chain step, independent of segment
 * count. Requiring it to also share no raw path segment with the pool closes
 * the gap without penalizing genuine single-word chain steps of any depth.
 * The overlap check drops the same short/generic segments
 * {@link pathStructuralTokens} already excludes ({@link GENERIC_PATH_TOKENS},
 * <3 chars): otherwise two completely unrelated endpoint families sharing
 * only a boilerplate `/api/` segment would be judged "related" and the
 * isolated capture would dodge exclusion the same way the empty-token-set
 * exemption originally let it. Pool paths that are themselves self-referential
 * ({@link hasRepeatedMeaningfulSegment}) are excluded from contributing to
 * this overlap set: otherwise two co-occurring same-noise-family path
 * variants (e.g. a POST and a GET/default variant of the same templated
 * marketing endpoint) would mutually "vouch" for each other's segments and
 * neither would be recognized as isolated — only a genuinely non-self-
 * referential path can vouch for a candidate's relatedness.
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
  const candidateTokens = pathStructuralTokens(candidatePath);
  if (candidateTokens.size > 0) return !isStructurallyRelevantCapture(candidatePath, poolPaths);
  if (!hasRepeatedMeaningfulSegment(candidatePath)) return false;
  const candidateSegments = meaningfulPathSegments(candidatePath);
  const poolSegments = new Set(
    poolPaths
      .filter((poolPath) => !hasRepeatedMeaningfulSegment(poolPath))
      .flatMap((poolPath) => meaningfulPathSegments(poolPath))
  );
  return !candidateSegments.some((segment) => poolSegments.has(segment));
}

/**
 * True when `pathA` and `pathB` belong to the same structural path family:
 * either they share a compound-segment token ({@link pathStructuralTokens}),
 * or both are self-referential ({@link hasRepeatedMeaningfulSegment}) and
 * share a raw meaningful segment (e.g. `widget` in both `/widget/api/promotions/widget`
 * and `/widget/api/promotions/widget/default`).
 *
 * Generalizes {@link isStructurallyRelevantCapture}'s token-overlap rule to
 * also cover the all-single-word-segment, self-referential shape that rule
 * alone can't see (its token set is empty for a path with no compound
 * segment) — the same shape {@link isStructurallyIsolatedCapture} already
 * recognizes for pool-isolation. Exported so a caller reasoning about
 * "is this OTHER capture part of the SAME noise family as an already-known
 * noise capture" (rather than "is this capture isolated from a whole pool")
 * can reuse the identical relatedness rule instead of re-deriving it.
 */
export function isSamePathFamily(pathA: string, pathB: string): boolean {
  const tokensA = pathStructuralTokens(pathA);
  const tokensB = pathStructuralTokens(pathB);
  if (tokensA.size > 0 && tokensB.size > 0) {
    for (const token of tokensA) {
      if (tokensB.has(token)) return true;
    }
  }
  if (!hasRepeatedMeaningfulSegment(pathA) || !hasRepeatedMeaningfulSegment(pathB)) return false;
  const segmentsA = new Set(meaningfulPathSegments(pathA));
  return meaningfulPathSegments(pathB).some((segment) => segmentsA.has(segment));
}

/**
 * Every string/number/boolean leaf reachable from `value`, stringified, with
 * `null`/`undefined` leaves skipped (they carry no derivable identifier to
 * compare against the request).
 */
function collectLeafValues(value: unknown, out: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "object") {
    for (const child of Array.isArray(value)
      ? value
      : Object.values(value as Record<string, unknown>)) {
      collectLeafValues(child, out);
    }
    return;
  }
  out.push(String(value));
}

/**
 * The set of raw values a request's own URL already exposes to the caller:
 * every query-parameter value and every non-empty path segment. A response
 * leaf that only ever echoes one of these tells the caller nothing it could
 * not already derive from the request it just sent.
 */
function urlOwnValues(url: string): Set<string> {
  const values = new Set<string>();
  try {
    const parsed = new URL(url);
    for (const value of parsed.searchParams.values()) values.add(value);
    for (const segment of parsed.pathname.split("/")) {
      if (segment.length > 0) values.add(decodeURIComponent(segment));
    }
  } catch {
    // unparsable URL contributes no derivable values
  }
  return values;
}

/**
 * The set of raw values a request's own POST body already exposes to the
 * caller: every leaf value of a JSON body, or every value of a URL-encoded
 * form body. Parsed the same permissive way {@link urlOwnValues} treats the
 * query string — an unparsable or absent body simply contributes no values,
 * never an error.
 */
function bodyOwnValues(requestPostData: string | null): Set<string> {
  const values = new Set<string>();
  if (!requestPostData) return values;
  try {
    const leaves: string[] = [];
    collectLeafValues(JSON.parse(requestPostData), leaves);
    for (const leaf of leaves) values.add(leaf);
    return values;
  } catch {
    // not JSON — fall through to URL-encoded form parsing
  }
  try {
    for (const value of new URLSearchParams(requestPostData).values()) values.add(value);
  } catch {
    // unparsable body contributes no derivable values
  }
  return values;
}

/**
 * True when every same-endpoint occurrence that carries a response body has
 * a response fully explained by that SAME occurrence's own request — every
 * response leaf is one of that occurrence's own URL query/path values or its
 * own POST body's own values. A same-origin noise widget's varying response
 * (a fresh session id, an incrementing counter) has no such relationship to
 * its own request; a real per-item drill's response is, by definition, a
 * function of the identifier the caller just sent it. This is what tells the
 * two apart when they are otherwise indistinguishable by cardinality alone —
 * {@link MIN_DENSE_REPEAT_FOR_RESPONSE_VARIANCE_SIGNAL}'s own docs note a
 * drill's `{ productId }` body produces a response signature "just as
 * high-cardinality as an actual per-call-varying beacon's fingerprint."
 * Requires at least two occurrences to actually carry a body, mirroring
 * {@link hasFreelyVaryingResponseAcrossOccurrences}'s own evidence floor.
 */
function hasResponseFullyExplainedByOwnRequestPerOccurrence(
  sameEndpoint: readonly {
    url: string;
    requestPostData: string | null;
    responseBody?: unknown;
  }[]
): boolean {
  const withBody = sameEndpoint.filter((c) => c.responseBody !== undefined);
  if (withBody.length < 2) return false;
  return withBody.every((occurrence) => {
    const leaves: string[] = [];
    collectLeafValues(occurrence.responseBody, leaves);
    if (leaves.length === 0) return false;
    const ownValues = new Set([
      ...urlOwnValues(occurrence.url),
      ...bodyOwnValues(occurrence.requestPostData),
    ]);
    return leaves.every((leaf) => ownValues.has(leaf));
  });
}

/**
 * True when `capture`'s response carries no business-relevant state: a
 * non-JSON (or absent) content-type, a null/undefined body, a JSON body
 * with no keys, or a JSON body whose every leaf value is already present in
 * the request's own URL (query string or path). A page-load sensor/
 * analytics beacon (an Akamai-style session-authenticator pixel, a polled
 * non-JSON status ping, or one that echoes back the `clientId`/`siteId` the
 * caller just sent it) answers every call with exactly this shape — unlike a
 * real API response, which carries data a caller could not have already
 * known before firing the request.
 *
 * The "echoes its own request" branch is what closes the gap a bare
 * empty-body check misses: a response is technically non-empty JSON but
 * every leaf is one of the fixed query's own values (or a path segment),
 * so nothing in it is new information relative to what the caller already
 * sent — it is not business-relevant just because it happens to be
 * non-empty.
 *
 * Missing response metadata (unit-test callers that construct a capture
 * without `responseHeaders`/`responseBody`) reads as "no business-relevant
 * state" too: this predicate only ever narrows an already-recurring
 * candidate — {@link isZeroVarianceRepeatCapture} (already-fixed-query) and
 * `recon-generate.ts`'s own-repeat structural-isolation pass (already
 * repeats identically, regardless of query shape) — so defaulting to the
 * noise reading there costs nothing except in the caller that deliberately
 * supplies a JSON response to prove the opposite.
 *
 * Exported (not just used internally by {@link isZeroVarianceRepeatCapture})
 * because a same-host, fixed-request endpoint with NO query string at all
 * (e.g. a polled feature-toggle feed with a single-compound-segment path)
 * can be genuinely zero-business-value too, and query-key matching alone —
 * this file's `hasFixedKey` signal — has nothing to key off when there is no
 * query. Response business-value is the general, path/query-shape-independent
 * signal for "this repeat carries nothing a caller could not already know,"
 * so `recon-generate.ts` reuses it directly instead of the query-shape logic
 * that cannot apply to a query-less endpoint.
 */
export function hasNoBusinessRelevantResponseState(capture: {
  url: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
}): boolean {
  const headers = capture.responseHeaders ?? {};
  const contentType = (
    Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? ""
  ).toLowerCase();
  if (!contentType.includes("json")) return true;
  const body = capture.responseBody;
  if (body === null || body === undefined) return true;
  if (typeof body !== "object") return false;
  if (Object.keys(body as Record<string, unknown>).length === 0) return true;
  const leaves: string[] = [];
  collectLeafValues(body, leaves);
  if (leaves.length === 0) return true;
  const ownValues = urlOwnValues(capture.url);
  return leaves.every((leaf) => ownValues.has(leaf));
}

/**
 * Identity of the endpoint a URL addresses, ignoring its query string, so
 * recurrences of the same endpoint with a differently-ordered or
 * incidentally-varying query string still group as "the same endpoint"
 * instead of requiring the whole URL to be byte-identical. Mirrors
 * `recon-generate.ts`'s own `endpointKey` (origin + pathname) — the same
 * definition of "same endpoint" this codebase already uses for collapse and
 * variance reasoning elsewhere.
 */
function endpointOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/**
 * True when `candidate` carries at least one query key whose value stays
 * identical across every occurrence of the same endpoint in `allCaptures`,
 * and recurs at least once elsewhere at the same method and endpoint
 * (origin + pathname) — proof the endpoint's identifying signal is a fixed
 * query key, not the full query string. Any OTHER key that differs between
 * occurrences (a cache-buster, a session nonce) is incidental and does not
 * prevent the match, AND either the request body is also byte-identical
 * across every occurrence, or the response carries no business-relevant
 * state ({@link hasNoBusinessRelevantResponseState}).
 *
 * Grouping by the full URL string (byte-identical query) is too strict: a
 * real beacon can carry one incidental varying query key (a cache-buster or
 * session nonce that is never literally equal across calls) alongside its
 * genuinely fixed identifying keys (`clientId`, `environment`, `siteId`),
 * and requiring the entire string to match lets it escape exclusion
 * entirely. Per-key comparison against the candidate's own keys — rather
 * than requiring the whole set of keys or values to agree — is what
 * recovers the beacon: the fixed keys still prove the endpoint's identity,
 * the varying key is simply ignored because it never advances past
 * "matches on at least one key."
 *
 * A key is "fixed" when the candidate's own value for it is the STRICT
 * MAJORITY value across every same-endpoint occurrence in `allCaptures`
 * (more than half, with at least two supporting occurrences) — not
 * necessarily every single one. `allCaptures` is the full raw capture list,
 * which can include an incidental earlier/differently-scoped occurrence of
 * the same endpoint (a page load before the flow proper starts) that
 * legitimately carries a different value for every candidate key. Requiring
 * literal unanimity would let that one outlier veto the proof for the
 * entire flow's worth of genuinely fixed repeats; requiring only a majority
 * still refuses to flag a key that varies freely (no value would ever reach
 * a majority) while tolerating the minority-outlier shape a real archive
 * produces.
 *
 * The requirement that at least one key be fixed is deliberate, not an
 * extension/host special-case: it is what separates this from a genuinely
 * no-argument own endpoint that a flow legitimately polls with an identical
 * body every time (a feature-toggle feed, an availability heartbeat) —
 * those endpoints carry real business meaning and folding their repeats
 * into a single call is the collapse mechanism's job, not this predicate's.
 * A marketing/analytics beacon's own fixed identifying query is the tell a
 * plain body-repetition check can't see on its own, and is exactly the
 * shape {@link isStructurallyIsolatedCapture} can be fooled by — that
 * check's reference pool is every OTHER admitted capture, so N copies of
 * the same fixed-query request "vouch" for each other's path tokens and
 * none of them reads as isolated.
 *
 * The response-state fallback exists because a byte-identical-body
 * requirement alone misses a beacon whose body embeds a fingerprint,
 * timestamp, or session nonce that differs on every fire even though the
 * fixed query is the only signal that actually identifies the endpoint —
 * the body varies, but the response never carries anything the flow could
 * not already derive from the request itself. When the response DOES carry
 * business-looking (non-URL-derivable) values, that alone is not proof of a
 * real endpoint either: a beacon can stamp a fresh fingerprint/session id
 * into its own response on every fire, so this also falls back to
 * {@link hasFreelyVaryingResponseAcrossOccurrences} — a response that varies
 * on almost every occurrence is exactly as much noise as one that echoes the
 * request.
 *
 * A candidate with NO query string at all has no key to prove "fixed" —
 * `hasFixedKey` has nothing to key off — so it falls back to
 * {@link hasNoBusinessRelevantResponseState}, gated by
 * {@link MIN_QUERYLESS_REPEAT_COUNT} same-endpoint occurrences rather than the
 * fixed-query branch's bare `>= 2`. That higher bar is what keeps a
 * genuinely-polled own endpoint (e.g. a two-call `/health` check with no
 * response metadata supplied) from being misread as noise: with no headers
 * or body, {@link hasNoBusinessRelevantResponseState} itself defaults to "no
 * business-relevant state," so query-key-less repeats need to already look
 * densely repeated before that default is trusted.
 *
 * When the query-less candidate's request body is byte-identical across every
 * occurrence, a business-looking response is trusted only if it shows SOME
 * evidence of real state: either it varies almost every call
 * ({@link hasFreelyVaryingResponseAcrossOccurrences}) or it never varies at
 * all ({@link hasNoObservedResponseVariance}) both read as noise, because
 * neither demonstrates the bounded, repeats-dominate cycling (e.g. a boolean
 * flipping between two values) a genuinely-polled own endpoint produces.
 *
 * When the request body varies across occurrences (unlike the fixed-query
 * branch, which only needs the query key fixed), the missing-metadata
 * default is NOT trusted: a same-endpoint POST with a differing body per
 * call (e.g. a single `/graphql` endpoint fanning out distinct operations)
 * only reads as noise when the candidate explicitly supplies a
 * `content-type` header — otherwise the varying body is exactly the shape a
 * real multi-operation API produces, and treating "no metadata given" as
 * proof of noise would drop the whole flow. Once that header is present, a
 * business-looking response still falls back to
 * {@link hasFreelyVaryingResponseAcrossOccurrences} for the same reason as
 * the fixed-query branch — a same-origin widget can vary both its request
 * body and its response payload per call and still be noise. A byte-identical
 * body across every occurrence is unambiguous regardless of metadata, so that
 * case still defers fully to {@link hasNoBusinessRelevantResponseState}.
 */
/**
 * Minimum same-endpoint occurrence count required to flag a query-less
 * candidate as noise. Higher than the fixed-query branch's bare `>= 2`
 * because a query-less candidate has no fixed key to corroborate the match —
 * only the repeat count itself distinguishes a densely-polled sensor from a
 * legitimately-repeated own endpoint (a two-call `/health` check).
 */
const MIN_QUERYLESS_REPEAT_COUNT = 3;

/**
 * Minimum same-endpoint occurrence count required before a QUERY-LESS
 * candidate's LACK of observed response variance is trusted as a noise
 * signal — i.e. before {@link hasNoObservedResponseVariance} (identical
 * request, response never once shows a second value) or a query-less
 * candidate whose own request body ALSO varies every call is allowed to fall
 * through to {@link hasFreelyVaryingResponseAcrossOccurrences}.
 *
 * A query-less candidate has no fixed query key to independently corroborate
 * that every occurrence really is the same recurring widget (unlike the
 * fixed-query-key branch below, where a recurring key such as
 * `clientId`/`environment` already proves that). Two shapes need this
 * corroboration:
 *
 * 1. An identical-body query-less candidate whose response has never once
 *    shown a second value ({@link hasNoObservedResponseVariance}) is
 *    genuinely ambiguous at low count: a same-origin noise widget that
 *    happens to return one static value for its whole archived session
 *    looks identical to a real closed-set poll (a feature toggle) that
 *    simply has not flipped yet within a short capture window. A widget's
 *    response varying almost every call ({@link hasFreelyVaryingResponseAcrossOccurrences})
 *    is NOT gated here — nothing about an identical, unchanging request can
 *    explain a varying response, so that signal is trustworthy regardless
 *    of count.
 * 2. A query-less candidate whose own request body ALSO varies every call
 *    has no corroboration for {@link hasFreelyVaryingResponseAcrossOccurrences}
 *    either: a paged listing's `{ page: n }` body and a per-item drill's
 *    `{ productId }` body produce a response signature just as
 *    high-cardinality as an actual per-call-varying beacon's fingerprint, at
 *    the same low occurrence counts recon fixtures and most live flows
 *    exercise (a handful of pages, a handful of drilled items).
 *
 * In both shapes, occurrence count is the only remaining corroborating
 * signal for a query-less candidate: a same-origin widget fires on every
 * page load and accumulates a dense repeat count over one recon session,
 * while a real own endpoint's repeat count is bounded by how many
 * pages/items/polls the flow actually performs. This does NOT gate the
 * fixed-query-key branch, whose recurring key is itself the corroborating
 * signal a query-less candidate lacks — that branch's own regression
 * coverage proves the classification must hold well below this floor.
 */
const MIN_DENSE_REPEAT_FOR_RESPONSE_VARIANCE_SIGNAL = 10;

/**
 * Distinct pathnames belonging to endpoints OTHER than `candidateEndpoint`,
 * present in `allCaptures` — the reference pool {@link isCorroboratedByStructuralIsolation}
 * compares the candidate against. Drawn from the same capture run so the
 * signal stays intrinsic to this archive rather than any global assumption
 * about what a "real" path looks like.
 */
function otherEndpointPaths(
  candidateEndpoint: string,
  allCaptures: readonly { url: string }[]
): string[] {
  const paths = new Set<string>();
  for (const capture of allCaptures) {
    if (endpointOrigin(capture.url) === candidateEndpoint) continue;
    try {
      paths.add(new URL(capture.url).pathname);
    } catch {
      // unparsable URL contributes no comparison path
    }
  }
  return [...paths];
}

/**
 * The response-shape verdict {@link poolPathLooksNoiseShaped} compares
 * pairwise between a candidate and each pool path it might be "vouched for"
 * by: which of the two weak, corroboration-dependent noise signals
 * ({@link hasNoObservedResponseVariance} — a response that never once shows
 * a second state — or {@link hasFreelyVaryingResponseAcrossOccurrences} — one
 * that varies almost every call) a path's own occurrences exhibit, if any.
 * `null` means neither fires (the path shows genuine bounded/business-like
 * variance) — the common case for a real endpoint and the thing that makes
 * it trustworthy as a corroborator regardless of what it is being asked to
 * corroborate.
 */
type WeakNoiseSignal = "no-variance" | "freely-varying" | null;

function weakNoiseSignalFor(sameEndpoint: readonly { responseBody?: unknown }[]): WeakNoiseSignal {
  if (hasNoObservedResponseVariance(sameEndpoint)) return "no-variance";
  if (hasFreelyVaryingResponseAcrossOccurrences(sameEndpoint)) return "freely-varying";
  return null;
}

/**
 * True when `poolPath` should NOT be trusted as corroboration for
 * `candidateEndpoint`'s isolation check — i.e. what
 * {@link nonNoiseOtherEndpointPaths} excludes from the pool
 * {@link isCorroboratedByStructuralIsolation} compares a candidate's raw
 * segments/tokens against.
 *
 * A pool path with an intrinsically empty/echoed response
 * ({@link hasNoBusinessRelevantResponseState}) is excluded unconditionally —
 * that signal needs no corroboration of its own to trust, so a path that
 * shows it is disqualified as a corroborator regardless of what asked.
 *
 * Otherwise, a pool path is excluded only when BOTH it and the candidate it
 * is being asked to corroborate exhibit `"no-variance"` (see
 * {@link poolPathLooksNoiseShaped}'s own doc for why `"freely-varying"` is
 * exempt from this half of the rule): two distinct, structurally-unrelated
 * noise endpoints that merely share one raw path segment (e.g. a shared
 * infra/widget-family prefix) and are BOTH byte-identical-forever would
 * otherwise "vouch" for each other's raw-segment overlap and neither would
 * be recognized as isolated — mirroring why
 * {@link isStructurallyIsolatedCapture} excludes self-referential pool paths
 * from ITS overlap set.
 *
 * This mutual-exclusion rule fires ONLY for the `"no-variance"` signal (a
 * response that is byte-identical on every occurrence), never for
 * `"freely-varying"`: a real endpoint family routinely has TWO siblings that
 * both show freely-varying, near-unique responses (a paged listing and a
 * per-item drill both produce a different body on every call) — that shared
 * high-cardinality pattern is the NORMAL shape of genuine business data, not
 * evidence against it, and corroboration between such siblings is exactly
 * how {@link isZeroVarianceRepeatCapture} is designed to rescue a real,
 * low-occurrence, per-page/per-item candidate from its own high-cardinality
 * reading. A byte-identical response, in contrast, is never how a real
 * per-occurrence data endpoint behaves regardless of occurrence count, so
 * two such endpoints "corroborating" each other via nothing but a shared raw
 * segment carries no evidentiary weight. An occurrence count alone is
 * deliberately NOT used as this discriminator: that would repeat the exact
 * absolute-count mistake this corroboration check exists to correct.
 *
 * A pool path with no observed response body at all (the common case for a
 * chain's own plain sibling steps, which this file's fixtures never attach a
 * body to) contributes no evidence either way and is treated as a genuine
 * sibling — absence of data is not evidence of noise.
 */
function poolPathLooksNoiseShaped(
  poolPath: string,
  candidateEndpoint: string,
  candidateSignal: WeakNoiseSignal,
  allCaptures: readonly {
    method: string;
    url: string;
    requestPostData: string | null;
    responseHeaders?: Record<string, string>;
    responseBody?: unknown;
  }[]
): boolean {
  const atPoolPath = allCaptures.filter((capture) => {
    if (endpointOrigin(capture.url) === candidateEndpoint) return false;
    try {
      return new URL(capture.url).pathname === poolPath;
    } catch {
      return false;
    }
  });
  const withBody = atPoolPath.filter((capture) => capture.responseBody !== undefined);
  const representative = withBody[0];
  if (representative === undefined) return false;
  if (hasNoBusinessRelevantResponseState(representative)) return true;
  if (candidateSignal !== "no-variance") return false;
  const sameEndpoint = atPoolPath.filter((capture) => capture.method === representative.method);
  return weakNoiseSignalFor(sameEndpoint) === "no-variance";
}

/**
 * {@link otherEndpointPaths}, minus any pool path that is itself
 * {@link poolPathLooksNoiseShaped noise-shaped RELATIVE TO `candidate`} — the
 * corroboration pool {@link isCorroboratedByStructuralIsolation} actually
 * compares a candidate's raw segments/tokens against. Kept separate from the
 * raw, unfiltered {@link otherEndpointPaths} result because "no other
 * endpoint exists in this run at all" (isolation genuinely cannot be
 * established) and "every other endpoint in this run is itself noise"
 * (isolation from every LEGITIMATE sibling is fully established) are
 * different findings and must not collapse to the same "nothing to compare"
 * fallback.
 */
function nonNoiseOtherEndpointPaths(
  candidateEndpoint: string,
  candidateSameEndpoint: readonly { responseBody?: unknown }[],
  allCaptures: readonly {
    method: string;
    url: string;
    requestPostData: string | null;
    responseHeaders?: Record<string, string>;
    responseBody?: unknown;
  }[]
): string[] {
  const candidateSignal = weakNoiseSignalFor(candidateSameEndpoint);
  return otherEndpointPaths(candidateEndpoint, allCaptures).filter(
    (path) => !poolPathLooksNoiseShaped(path, candidateEndpoint, candidateSignal, allCaptures)
  );
}

/**
 * True when `a` and `b` are the same word, or one is a shared-stem prefix of
 * the other (e.g. `avail` / `available`, `product` / `products`) — the same
 * abbreviation and pluralization variants a same-flow endpoint family
 * routinely uses for what is, structurally, the same resource word. The
 * 4-character floor keeps this from firing on short, coincidentally-
 * overlapping fragments.
 */
function tokensShareStem(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && longer.startsWith(shorter);
}

/**
 * True when any token in `candidateTokens` shares a stem (see
 * {@link tokensShareStem}) with any token in `referenceTokens`.
 */
function sharesStemmedToken(
  candidateTokens: ReadonlySet<string>,
  referenceTokens: ReadonlySet<string>
): boolean {
  for (const candidateToken of candidateTokens) {
    for (const referenceToken of referenceTokens) {
      if (tokensShareStem(candidateToken, referenceToken)) return true;
    }
  }
  return false;
}

/**
 * True when a query-less candidate's repeat is corroborated as noise by
 * structural isolation from every OTHER distinct endpoint already present in
 * the same capture run — a signal intrinsic to the capture's relationship to
 * the rest of the flow, unlike an absolute occurrence count, which cannot
 * tell a low-count real endpoint apart from a low-count noise widget (both
 * produce the identical response-variance shape at a small sample size; see
 * capture-filters.test.ts's own paired isolated/related fixtures at the same
 * 7-occurrence count).
 *
 * Does NOT reuse {@link isStructurallyRelevantCapture}'s exact-token-equality
 * rule for a candidate with a compound segment: that rule is deliberately
 * strict because its job (schema-inference family membership) is hurt more
 * by a false "related" than a false "unrelated". This predicate's bias runs
 * the other way — a false "isolated" here discards a real endpoint's data as
 * noise — so it uses {@link sharesStemmedToken}'s more permissive stem
 * comparison instead: two same-flow endpoints commonly spell the same
 * resource word as an abbreviation or a different inflection (a `product-
 * avail` poll and an `available-products` listing sharing "avail"/
 * "available"), which an exact-token bar can't see. A plain-word candidate
 * (empty token set) does NOT get {@link isStructurallyIsolatedCapture}'s
 * conservative "assume related unless self-referential" fallback — that
 * fallback exists to protect a *plain-word chain step* from being misread as
 * noise when it shares no token with its siblings, which is the opposite of
 * what this predicate needs. But it also must not default to "isolated"
 * outright: a candidate that shares a raw meaningful segment with another
 * endpoint (e.g. `/user/profile` alongside a sibling `/user/profile/edit`,
 * or `/feature-toggles/catalog` alongside a sibling `/catalog/listing`) is
 * still demonstrably part of the same flow even when its compound segment's
 * tokens don't line up with the sibling's. So EVERY candidate — compound-
 * token or plain-word — additionally falls back to a raw-segment overlap
 * check when the token check finds nothing: isolated only when it shares
 * nothing, stemmed token or raw segment, with any other endpoint in the run
 * (an `/pulse/api/v1/urgency`-shaped candidate sharing nothing with the rest
 * of the flow).
 *
 * When the run captured no OTHER distinct endpoint at all, there is nothing
 * to compare against, so isolation cannot be established either way — the
 * caller falls back to the occurrence-count floor in that case.
 *
 * The comparison pool is split into two arguments on purpose:
 * `otherPaths` (every other distinct endpoint captured in the run, raw and
 * unfiltered) only answers "is there anything to compare against at all",
 * while `corroboratingPaths` ({@link nonNoiseOtherEndpointPaths}, with any
 * pool path that is itself {@link poolPathLooksNoiseShaped noise-shaped}
 * excluded) is what the token/segment overlap is actually checked against.
 * Using the unfiltered pool for both would let two distinct, structurally-
 * unrelated noise endpoints that merely share one raw path segment "vouch"
 * for each other via that shared segment, so neither is ever recognized as
 * isolated — the raw-segment fallback below has no protection of its own
 * against that the way {@link isStructurallyIsolatedCapture} already does
 * for its pool.
 */
function isCorroboratedByStructuralIsolation(
  candidatePath: string,
  otherPaths: readonly string[],
  corroboratingPaths: readonly string[]
): boolean {
  if (otherPaths.length === 0) return false;
  const candidateTokens = pathStructuralTokens(candidatePath);
  if (
    candidateTokens.size > 0 &&
    corroboratingPaths.some((otherPath) =>
      sharesStemmedToken(candidateTokens, pathStructuralTokens(otherPath))
    )
  ) {
    return false;
  }
  const candidateSegments = meaningfulPathSegments(candidatePath);
  if (candidateSegments.length === 0) return false;
  const otherSegments = new Set(corroboratingPaths.flatMap((path) => meaningfulPathSegments(path)));
  return !candidateSegments.some((segment) => otherSegments.has(segment));
}

/**
 * True when same-endpoint occurrences carry JSON response bodies that are
 * mostly pairwise distinct — i.e. the payload never settles back into a
 * value it has already shown.
 *
 * This is what tells a genuinely-polled own endpoint (a feature-toggle feed,
 * a health check) apart from a query-less noise widget whose response merely
 * LOOKS like real data: both can carry non-URL-derivable JSON leaves, but a
 * real polled endpoint cycles through a small closed set of states (a
 * boolean flips between two values, say), so most occurrences duplicate an
 * earlier one, while a per-load noise widget (a chat-bubble loader stamping
 * a fresh counter/session id into its own response) produces a near-unique
 * value on almost every occurrence. Comparing each occurrence against just
 * the candidate's own value can't distinguish these — a two-state toggle and
 * an ever-incrementing counter both differ from any single candidate about
 * half the time — so this counts distinct values across ALL occurrences
 * instead: a low-cardinality set (repeats dominate) is a real poll, a
 * high-cardinality set (values rarely repeat) is noise. Occurrences with no
 * response metadata supplied contribute no evidence either way, so this only
 * fires when at least two occurrences actually carry a body to compare.
 */
function hasFreelyVaryingResponseAcrossOccurrences(
  sameEndpoint: readonly { responseBody?: unknown }[]
): boolean {
  const { withBody, distinctSignatures } = responseSignatureCardinality(sameEndpoint);
  if (withBody.length < 2) return false;
  return distinctSignatures.size > withBody.length / 2;
}

/**
 * Distinct JSON-response signatures observed across same-endpoint occurrences,
 * alongside the subset that actually carried a body — the shared cardinality
 * count {@link hasFreelyVaryingResponseAcrossOccurrences} (high-cardinality
 * noise) and {@link hasNoObservedResponseVariance} (zero-cardinality noise)
 * each read off, so the two "not real state" signals can't drift apart on
 * how a signature is computed.
 */
function responseSignatureCardinality(sameEndpoint: readonly { responseBody?: unknown }[]): {
  withBody: readonly { responseBody?: unknown }[];
  distinctSignatures: Set<string>;
} {
  const withBody = sameEndpoint.filter((c) => c.responseBody !== undefined);
  return {
    withBody,
    distinctSignatures: new Set(withBody.map((c) => JSON.stringify(c.responseBody))),
  };
}

/**
 * True when every same-endpoint occurrence that carried a response body
 * carried the SAME body — i.e. the response never once demonstrated a
 * second state. A genuinely-polled own endpoint with real closed-set state
 * (a toggle that flips between two values) shows at least one differing
 * occurrence somewhere in the archive; a query-less noise widget that
 * happens to have been captured returning one static, business-looking-but-
 * non-URL-derivable value for the whole archived session shows none. This is
 * the query-less-only counterpart to {@link hasFreelyVaryingResponseAcrossOccurrences}:
 * that one catches a widget whose value changes almost every call, this one
 * catches the opposite extreme — a widget whose value never changes at all —
 * neither of which is evidence of the bounded, repeats-dominate cycling a
 * real closed-set poll produces.
 */
function hasNoObservedResponseVariance(
  sameEndpoint: readonly { responseBody?: unknown }[]
): boolean {
  const { withBody, distinctSignatures } = responseSignatureCardinality(sameEndpoint);
  return withBody.length >= 2 && distinctSignatures.size <= 1;
}

/**
 * Strips leading blank lines and `#`-comment lines (GraphQL comments run
 * from `#` to end of line) so operation-signature regexes anchored at the
 * `query`/`mutation` keyword still match documents preceded by a comment.
 */
function stripLeadingGraphQLComments(query: string): string {
  return query.replace(/^(?:[ \t]*(?:#[^\n]*)?\r?\n)*/, "");
}

/**
 * Parses the operation name out of the query body itself, for captures whose
 * top-level `operationName` field is null (an inline document with no
 * separate operationName was still sent with a named `query`/`mutation`).
 */
export function parsedOperationName(query: string): string | null {
  const signature = /^\s*(?:query|mutation)\s+(\w+)/.exec(stripLeadingGraphQLComments(query));
  return signature?.[1] ?? null;
}

/**
 * An occurrence's effective operation identity: the raw `operationName`
 * field when present, otherwise the name parsed out of its `query` text —
 * the same fallback `recon-generate.ts`'s `operationGroupKey` uses for
 * recurrence counting, so a client that only sends a named inline document
 * (no separate `operationName` field) still corroborates as one identity.
 */
function effectiveOperationName(occurrence: {
  operationName?: string | null;
  query?: string | null;
}): string | null {
  return occurrence.operationName ?? parsedOperationName(occurrence.query ?? "") ?? null;
}

/**
 * Structural shape of a JSON value with every leaf collapsed to its
 * `typeof` and every array collapsed to the shape of its first element —
 * i.e. equal for two responses that carry the same schema but different
 * data (`{ destination: "region-3" }` vs `{ destination: "region-9" }`
 * both become `{destination:string}`). This is what lets an Automatic-
 * Persisted-Query re-issue (see {@link hasStableOperationIdentity}'s own
 * doc) be recognized as belonging to a named operation's response family
 * by shape alone, without relying on any value the request/response pair
 * happens to carry.
 */
function responseShapeSignature(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.length > 0 ? responseShapeSignature(value[0]) : ""}]`;
  }
  if (typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${key}:${responseShapeSignature((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return typeof value;
}

/**
 * True when `candidate`'s operationName is non-empty and recurs at least
 * twice among `sameEndpoint`. That recurrence is sufficient evidence of a
 * stable, repeatedly-invoked identity on its own — how much OTHER traffic
 * happens to share the endpoint has no bearing on whether THIS operation
 * is real, so no comparison against other operationName groups is made.
 * A stable operation identity carried by the call itself — not derived
 * from the URL or body, which are expected to vary per-call for a real
 * re-issued operation — is evidence of a real, repeatedly-invoked API
 * call rather than a noise widget that merely happens to recur densely.
 *
 * A candidate whose OWN occurrence carries neither an `operationName` nor
 * a `query` (an Automatic-Persisted-Query re-issue: the client sends only
 * a persisted-query hash after the server has already cached the
 * document, so this exact occurrence has no self-declared identity at
 * all) cannot be grouped by {@link effectiveOperationName} — it falls out
 * of every group's count and would otherwise fall through to the raw
 * response-cardinality checks alongside every OTHER distinct operation
 * multiplexed on the same endpoint, which reads as "freely varying" and
 * misclassifies it as noise. Corroborating it against a same-endpoint
 * IDENTIFIED group's response shape ({@link responseShapeSignature},
 * structural — ignores the actual data values, which are expected to
 * differ per-call) recovers it exactly the way a fixed query key
 * corroborates a beacon's identity elsewhere in this file: the shape a
 * named group's responses share is itself evidence the candidate is a
 * re-issue of that SAME operation, not a coincidental schema collision
 * with a one-off. The matched group must still clear the same `>= 2`
 * recurrence bar as the named-identity path — an unidentified candidate
 * gets no less scrutiny than an identified one.
 */
function hasStableOperationIdentity(
  candidate: { operationName?: string | null; query?: string | null; responseBody?: unknown },
  sameEndpoint: readonly {
    operationName?: string | null;
    query?: string | null;
    responseBody?: unknown;
  }[]
): boolean {
  const groupCounts = new Map<string, number>();
  const groupShapes = new Map<string, string>();
  for (const c of sameEndpoint) {
    const identity = effectiveOperationName(c);
    if (!identity) continue;
    groupCounts.set(identity, (groupCounts.get(identity) ?? 0) + 1);
    if (!groupShapes.has(identity) && c.responseBody !== undefined) {
      groupShapes.set(identity, responseShapeSignature(c.responseBody));
    }
  }
  const candidateIdentity = effectiveOperationName(candidate);
  if (candidateIdentity) {
    const candidateCount = groupCounts.get(candidateIdentity) ?? 0;
    return candidateCount >= 2;
  }
  if (candidate.responseBody === undefined) return false;
  const candidateShape = responseShapeSignature(candidate.responseBody);
  const matchedIdentity = [...groupShapes.entries()].find(
    ([, shape]) => shape === candidateShape
  )?.[0];
  if (!matchedIdentity) return false;
  const matchedCount = groupCounts.get(matchedIdentity) ?? 0;
  return matchedCount >= 2;
}

export function isZeroVarianceRepeatCapture(
  candidate: {
    method: string;
    url: string;
    requestPostData: string | null;
    responseHeaders?: Record<string, string>;
    responseBody?: unknown;
    operationName?: string | null;
    query?: string | null;
  },
  allCaptures: readonly {
    method: string;
    url: string;
    requestPostData: string | null;
    responseHeaders?: Record<string, string>;
    responseBody?: unknown;
    operationName?: string | null;
    query?: string | null;
  }[]
): boolean {
  let candidateUrl: URL;
  try {
    candidateUrl = new URL(candidate.url);
  } catch {
    return false;
  }
  const candidateEndpoint = endpointOrigin(candidate.url);
  if (candidateEndpoint === null) return false;
  const candidateKeys = [...candidateUrl.searchParams.keys()];
  const sameEndpoint = allCaptures.filter(
    (c) => c.method === candidate.method && endpointOrigin(c.url) === candidateEndpoint
  );
  if (candidateKeys.length === 0) {
    if (sameEndpoint.length < MIN_QUERYLESS_REPEAT_COUNT) return false;
    const queryLessBodyIdentical = sameEndpoint.every(
      (c) => c.requestPostData === candidate.requestPostData
    );
    if (queryLessBodyIdentical) {
      if (hasNoBusinessRelevantResponseState(candidate)) return true;
      if (hasFreelyVaryingResponseAcrossOccurrences(sameEndpoint)) return true;
      if (
        sameEndpoint.length < MIN_DENSE_REPEAT_FOR_RESPONSE_VARIANCE_SIGNAL &&
        !isCorroboratedByStructuralIsolation(
          candidateUrl.pathname,
          otherEndpointPaths(candidateEndpoint, allCaptures),
          nonNoiseOtherEndpointPaths(candidateEndpoint, sameEndpoint, allCaptures)
        )
      ) {
        return false;
      }
      return hasNoObservedResponseVariance(sameEndpoint);
    }
    const hasExplicitContentType = Object.keys(candidate.responseHeaders ?? {}).some(
      (key) => key.toLowerCase() === "content-type"
    );
    if (!hasExplicitContentType) return false;
    if (hasResponseFullyExplainedByOwnRequestPerOccurrence(sameEndpoint)) return false;
    if (hasNoBusinessRelevantResponseState(candidate)) return true;
    if (hasStableOperationIdentity(candidate, sameEndpoint)) return false;
    if (
      sameEndpoint.length < MIN_DENSE_REPEAT_FOR_RESPONSE_VARIANCE_SIGNAL &&
      !isCorroboratedByStructuralIsolation(
        candidateUrl.pathname,
        otherEndpointPaths(candidateEndpoint, allCaptures),
        nonNoiseOtherEndpointPaths(candidateEndpoint, sameEndpoint, allCaptures)
      )
    ) {
      return false;
    }
    return hasFreelyVaryingResponseAcrossOccurrences(sameEndpoint);
  }
  if (sameEndpoint.length < 2) return false;
  const sameEndpointUrls = sameEndpoint
    .map((c) => {
      try {
        return new URL(c.url);
      } catch {
        return null;
      }
    })
    .filter((u): u is URL => u !== null);
  const hasFixedKey = candidateKeys.some((key) => {
    const candidateValue = candidateUrl.searchParams.get(key);
    const matchCount = sameEndpointUrls.filter(
      (u) => u.searchParams.get(key) === candidateValue
    ).length;
    return matchCount >= 2 && matchCount > sameEndpointUrls.length / 2;
  });
  if (!hasFixedKey) return false;
  const bodyIdentical = sameEndpoint.every((c) => c.requestPostData === candidate.requestPostData);
  if (bodyIdentical) return true;
  if (hasNoBusinessRelevantResponseState(candidate)) return true;
  if (hasStableOperationIdentity(candidate, sameEndpoint)) return false;
  return hasFreelyVaryingResponseAcrossOccurrences(sameEndpoint);
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
