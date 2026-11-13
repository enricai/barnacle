/**
 * Maximum redirect hops followed while preserving the request method.
 * Bounds a redirect loop; five matches the conventional browser limit.
 */
const MAX_METHOD_PRESERVING_REDIRECTS = 5;

/** The single decision of which redirect statuses are followed. */
export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

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
  onHop?: (hop: { status: number; headers: Headers; url: string }) => void,
): Promise<Response> {
  const { fetchImpl = fetch, ...rest } = init;
  const currentInit: RequestInit = { ...rest, redirect: "manual" };
  // Cookies minted by intermediate hops, by name, newest winning. A login or
  // consent redirect commonly sets the session cookie on the 302 itself, so
  // dropping these makes the final request arrive unauthenticated.
  const hopCookies = new Map<string, string>();
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

    // `Set-Cookie` is `name=value; Path=/; HttpOnly` — the FIRST pair is the
    // cookie and the rest are attributes, so only the first is carried
    // forward. Attributes (Domain, Path, Expires) are deliberately not
    // honored: this is a short-lived redirect chain inside one logical
    // request, not a cookie jar.
    const nextUrl = new URL(location, currentUrl);
    for (const setCookie of response.headers.getSetCookie()) {
      const [first] = parseCookiePairs(setCookie);
      if (first !== undefined) hopCookies.set(first[0], first[1]);
    }
    if (hopCookies.size > 0) {
      const headers = {
        ...(currentInit.headers as Record<string, string> | undefined),
      };
      const existingKey =
        Object.keys(headers).find((k) => k.toLowerCase() === "cookie") ??
        "Cookie";
      // Merge rather than replace, so a cookie the caller sent survives
      // alongside the hop's — and a hop setting the same name wins, since it
      // is the more current value.
      const merged = new Map(parseCookiePairs(headers[existingKey] ?? ""));
      for (const [name, value] of hopCookies) merged.set(name, value);
      headers[existingKey] = [...merged.entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
      currentInit.headers = headers;
    }

    currentUrl = nextUrl.toString();
  }
  throw new Error(
    `exceeded ${MAX_METHOD_PRESERVING_REDIRECTS} redirects starting at ${url}`,
  );
}

/**
 * Parses a `name=value; name=value` Cookie header string into per-cookie
 * entries, paralleling the pair-splitting `extractCookieValue` already does
 * for `Set-Cookie`. Skips malformed segments (no `=`) rather than throwing —
 * an operator-authored `baseHeaders` or per-call `init.headers` Cookie value
 * is untrusted input, not a value this module produced.
 */
export function parseCookiePairs(
  cookieHeader: string,
): Array<[string, string]> {
  return cookieHeader
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .flatMap((pair) => {
      const eq = pair.indexOf("=");
      return eq === -1
        ? []
        : [[pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()] as const];
    });
}
