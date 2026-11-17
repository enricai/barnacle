import { RedirectCookieJar } from "./redirect-cookie-jar.js";

/**
 * Maximum redirect hops followed while preserving the request method.
 * Bounds a redirect loop; five matches the conventional browser limit.
 */
const MAX_METHOD_PRESERVING_REDIRECTS = 5;

/** The single decision of which redirect statuses are followed. */
export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Follows redirects without silently downgrading the request method.
 *
 * `fetch`'s default `redirect: "follow"` implements the historical browser
 * rule: on a 301/302 it may rewrite a POST into a GET and drop the body. A
 * JSON API reached through a redirecting path then receives a bodyless GET
 * and answers 404/411/400 — a failure that reads as the endpoint refusing the
 * caller rather than the redirect mangling the request, which makes it
 * expensive to diagnose.
 *
 * Example: `POST https://example.com/api/v2/items` 301s to a locale-prefixed
 * path for some egress regions. Following it with the default policy yields
 * 404 HTML; re-issuing the same POST and body at the `Location` yields 200.
 * Any site that 301s its API path turns every POST drill into a 404 under
 * the default policy.
 *
 * Because `redirect: "manual"` is forced, `fetch` follows nothing itself, so
 * 307/308 are followed here too. 301/302/303/307/308 are all followed
 * manually under one rule, re-issuing the original method, headers and body
 * (a 303 is not downgraded to a GET). A relative `Location` resolves against the URL that
 * produced it. No redirect is the common case and costs one extra
 * `redirect: "manual"` fetch and nothing else.
 *
 * Two things following the chain by hand lets us do that `fetch` cannot:
 * `Set-Cookie` headers from intermediate hops are carried onto the follow-up
 * request (a site that mints its session on the 302 would otherwise land
 * unauthenticated), and `onHop` reports every response in the chain so a
 * caller's response bindings can read headers that only ever appear on a
 * redirect.
 */
export async function fetchFollowingRedirectsPreservingMethod(
  url: string,
  init: RequestInit & { fetchImpl?: typeof fetch },
  onHop?: (hop: { status: number; headers: Headers; url: string }) => void
): Promise<Response> {
  const { fetchImpl = fetch, ...rest } = init;
  const currentInit: RequestInit = { ...rest, redirect: "manual" };
  // Credentials the caller sent were meant for the original origin only.
  // Each hop's headers are derived from this snapshot: full when the hop is
  // back on the original origin, credential-stripped otherwise.
  const originalHeaders = headersToRecord(rest.headers);
  const strippedHeaders = Object.fromEntries(
    Object.entries(originalHeaders).filter(([name]) => !isCredentialHeader(name))
  );
  // An unparseable URL must reach fetch so it rejects there as before.
  let originalOrigin: string | null = null;
  try {
    originalOrigin = new URL(url).origin;
  } catch {
    // left null; fetchImpl reports the invalid URL
  }
  let leftOriginalOrigin = false;
  // Cookies minted by intermediate hops, by name, newest winning. A login or
  // consent redirect commonly sets the session cookie on the 302 itself, so
  // dropping these makes the final request arrive unauthenticated.
  const jar = new RedirectCookieJar();
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_METHOD_PRESERVING_REDIRECTS; hop += 1) {
    const response = await fetchImpl(currentUrl, currentInit);
    onHop?.({
      status: response.status,
      headers: response.headers,
      url: currentUrl,
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    // A redirect status with no usable Location is not followable; hand it
    // back so the caller's status classification reports the real response
    // rather than a synthesized error.
    if (location === null || location === "") return response;

    // Hop-minted cookies go into a jar that only returns what a real cookie
    // jar would send to the next URL (host/domain, path, Secure, expiry).
    const nextUrl = new URL(location, currentUrl);
    const hopUrl = new URL(currentUrl);
    for (const setCookie of response.headers.getSetCookie()) {
      jar.add(setCookie, hopUrl);
    }
    // Once any hop leaves the original origin, credentials stay stripped for
    // the rest of the chain (Fetch spec); a later hop back cannot restore them.
    if (nextUrl.origin !== originalOrigin) leftOriginalOrigin = true;
    // Always rebuild from the snapshot so a cookie attached for an earlier hop
    // never rides along to a hop the jar no longer selects it for.
    currentInit.headers = { ...(leftOriginalOrigin ? strippedHeaders : originalHeaders) };
    const hopCookies = jar.select(nextUrl);
    if (hopCookies.length > 0) {
      const headers = new Headers(currentInit.headers);
      // Merge rather than replace, so a cookie the caller sent survives
      // alongside the hop's — and a hop setting the same name wins, since it
      // is the more current value.
      const merged = new Map(parseCookiePairs(headers.get("cookie") ?? ""));
      for (const [name, value] of hopCookies) merged.set(name, value);
      headers.set(
        "cookie",
        [...merged.entries()].map(([name, value]) => `${name}=${value}`).join("; ")
      );
      currentInit.headers = headers;
    }

    currentUrl = nextUrl.toString();
  }
  throw new Error(`exceeded ${MAX_METHOD_PRESERVING_REDIRECTS} redirects starting at ${url}`);
}

/**
 * Parses a `name=value; name=value` Cookie header string into per-cookie
 * entries, paralleling the pair-splitting `extractCookieValue` already does
 * for `Set-Cookie`. Skips malformed segments (no `=`) rather than throwing —
 * an operator-authored `baseHeaders` or per-call `init.headers` Cookie value
 * is untrusted input, not a value this module produced.
 */
export function parseCookiePairs(cookieHeader: string): Array<[string, string]> {
  return cookieHeader
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .flatMap((pair) => {
      const eq = pair.indexOf("=");
      return eq === -1 ? [] : [[pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()] as const];
    });
}

// Header names cannot be reliably classified as credential-bearing, so a
// cross-origin hop keeps only headers known to be content negotiation or
// client identification; everything else is treated as potentially secret.
const CROSS_ORIGIN_SAFE_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-language",
  "accept-encoding",
  "content-type",
  "user-agent",
  "cache-control",
  "pragma",
]);

/** True for headers that may carry a credential and must not cross origins. */
export function isCredentialHeader(name: string): boolean {
  return !CROSS_ORIGIN_SAFE_HEADERS.has(name.toLowerCase());
}

/** Normalizes Headers, tuple arrays or records into a plain record. */
function headersToRecord(headers: RequestInit["headers"] | undefined): Record<string, string> {
  if (headers === undefined) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...(headers as Record<string, string>) };
}
