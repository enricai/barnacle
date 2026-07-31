/**
 * Match `pattern` against `url` and return the first capture group.
 * Invokes `onMiss` (which must throw) when the pattern does not match
 * or has no capture group. Callers supply their own regex and throw
 * so plugin-specific error classes and messages are preserved exactly.
 */
export function matchUrlCaptureGroup(url: string, pattern: RegExp, onMiss: () => never): string {
  const match = url.match(pattern);
  if (!match || match[1] === undefined) {
    onMiss();
  }
  return match[1] as string;
}
