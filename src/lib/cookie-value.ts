/**
 * Generic cookie-string parser. Extracts a named cookie's value from a
 * `document.cookie` string (the semicolon-separated `name=value` format the
 * browser exposes). Site-specific callers keep the cookie name at their call
 * sites so this helper stays domain-agnostic.
 */
export function getCookieValue(cookieStr: string, name: string): string | undefined {
  const match = cookieStr.match(new RegExp(`${name}=([^;]+)`));
  return match?.[1];
}
