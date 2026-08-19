/**
 * Tiny RNG helpers shared by scraper jitter and metrics reservoir sampling.
 *
 * Exists because hand-rolled `Math.floor(Math.random() * ...)` and inline
 * `pick a random index` blocks were duplicated across throttle.ts, metrics.ts,
 * and session.ts. Centralising them keeps the bounds semantics (inclusive on
 * both sides) consistent and gives the call sites a single name to scan for.
 */

import { randomBytes } from "node:crypto";

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

/**
 * Mints a fresh, single-use credential value for a flow step that must fill a
 * password field but has no caller-supplied secret to splice — recon-captured
 * credentials must never leak into a generated flow, and a fixed literal would
 * be a shared secret across every run. `node:crypto`'s CSPRNG (not `Math.random`,
 * which backs the jitter helpers above) keeps the value unguessable.
 */
export function generateThrowawayPassword(): string {
  return randomBytes(24).toString("base64url");
}
