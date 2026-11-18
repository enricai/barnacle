// Cross-origin redirect hops forward only headers known to carry no
// credential. Everything else the caller sent is dropped, so an unrecognized
// credential header (any custom name) can never leak to another origin.
const SAFE_CROSS_ORIGIN_HEADERS = new Set([
  "accept",
  "accept-charset",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-language",
  "content-type",
  "pragma",
  "user-agent",
  "dnt",
  "upgrade-insecure-requests",
  // Browser-recon headers that identify the request, not the caller.
  "origin",
  "referer",
  "x-requested-with",
  "range",
  "if-none-match",
  "if-modified-since",
  "anthropic-version",
  "anthropic-beta",
]);

/** True when a header may be forwarded to a different origin. */
export function isCrossOriginSafeHeader(name: string): boolean {
  return SAFE_CROSS_ORIGIN_HEADERS.has(name.toLowerCase());
}

/** Keeps only the allowlisted headers of a record (cross-origin hops). */
export function stripToSafeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([n]) => isCrossOriginSafeHeader(n)));
}
