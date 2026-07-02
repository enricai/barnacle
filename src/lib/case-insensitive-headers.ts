/**
 * Case-insensitive lookup for HTTP header records whose keys may arrive in
 * any capitalisation (e.g. CDP `requestWillBeSent` headers from Chromium vs.
 * Node `http.IncomingMessage` lower-cased headers). HTTP/1.1 §4.2 specifies
 * header names are case-insensitive, but JS objects are not — this bridges
 * the gap without requiring callers to normalise keys up front.
 */
export function lookupHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

/**
 * Returns a copy of the header record with the named key removed, matching
 * case-insensitively. Needed when passing FormData to fetch — the caller must
 * drop Content-Type so fetch can set the multipart boundary itself.
 */
export function omitHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string
): Record<string, string> {
  const lower = name.toLowerCase();
  return Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== lower));
}
