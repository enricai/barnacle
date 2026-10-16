/**
 * Tiny RNG helpers shared by scraper jitter and metrics reservoir sampling.
 *
 * Exists because hand-rolled `Math.floor(Math.random() * ...)` and inline
 * `pick a random index` blocks were duplicated across throttle.ts, metrics.ts,
 * and session.ts. Centralising them keeps the bounds semantics (inclusive on
 * both sides) consistent and gives the call sites a single name to scan for.
 */

import { randomInt } from "node:crypto";

import { registerSecretValue } from "@/lib/pii-redaction";

/**
 * Returns a uniformly distributed integer in the inclusive range [min, max].
 * If `max <= min` the function returns `min` rather than producing NaN or
 * an out-of-range value — callers in throttle/metrics rely on this guard.
 */
export function randomIntInclusive(min: number, max: number): number {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Picks a uniformly random element from a non-empty readonly array. Falls
 * back to `arr[0]` so the return type stays `T` (no undefined leakage) even
 * if a typed empty array is somehow passed in — TypeScript's `readonly T[]`
 * type does not prove non-emptiness at compile time.
 */
export function pickRandom<T>(arr: readonly T[]): T {
  const index = randomIntInclusive(0, arr.length - 1);
  return arr[index] ?? (arr[0] as T);
}

const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const SPECIALS = "!@#%^*()-+=?.";
const PASSWORD_LENGTH = 24;

function pickChar(charset: string): string {
  return charset.charAt(randomInt(charset.length));
}

/**
 * Mints a fresh, single-use credential value for a flow step that must fill a
 * password field but has no caller-supplied secret to splice — recon-captured
 * credentials must never leak into a generated flow, and a fixed literal would
 * be a shared secret across every run. `node:crypto`'s CSPRNG (not `Math.random`,
 * which backs the jitter helpers above) keeps the value unguessable. Sites
 * commonly enforce upper/lower/digit/special policies, so one character of each
 * class is guaranteed and the result is Fisher-Yates shuffled with `randomInt`
 * (unbiased) so the guaranteed characters sit at unpredictable positions. The
 * alphabet excludes quotes, backticks, backslashes and `$` because flows splice
 * the value into template literals. The value is registered for redaction
 * because flows embed it in step instructions that reach logs and telemetry.
 */
export function generateThrowawayPassword(): string {
  const all = UPPERCASE + LOWERCASE + DIGITS + SPECIALS;
  const chars = [pickChar(UPPERCASE), pickChar(LOWERCASE), pickChar(DIGITS), pickChar(SPECIALS)];
  while (chars.length < PASSWORD_LENGTH) chars.push(pickChar(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = chars[i] as string;
    chars[i] = chars[j] as string;
    chars[j] = tmp;
  }
  const password = chars.join("");
  registerSecretValue(password);
  return password;
}
