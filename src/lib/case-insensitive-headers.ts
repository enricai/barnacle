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
