/**
 * Frame-attach timeout resolution, split out of `frame-target.ts` so the
 * value-selection contract (explicit override > `FRAME_READY_TIMEOUT_MS` env
 * override > raised default) is unit-testable without a `Page`/`Frame` fake.
 * Mirrors `resolveGotoWaitUntil` (`@/scripts/recon-browser`): a raw string in,
 * a `warn` on anything that can't produce a usable positive timeout, never a
 * thrown error.
 */

import { getLogger } from "@/lib/logging";
import type { Logger } from "@/types/logging";

const logger = getLogger({ name: "scraper/frame-ready-timeout" });

/**
 * Raised from the historical hardcoded 5s: cross-origin OOPIFs (e.g.
 * Talemetry's apply iframe) attach in ~3-4s in a bare Stagehand session but
 * regularly exceed 5s under advancedStealth + proxied CDP overhead.
 */
export const FRAME_READY_TIMEOUT_DEFAULT_MS = 20_000;

/**
 * Resolves the frame-attach poll timeout for `resolveFrameTarget` /
 * `waitForChildFrameReady`. `opts.timeoutMs` (a per-call override, e.g. from
 * tests or a future call-site tuning knob) always wins over the environment;
 * `raw` (defaulted to `process.env.FRAME_READY_TIMEOUT_MS` at call time, not
 * module load, so it stays testable) is parsed only when no explicit
 * override is given. An unset `raw` falls back to
 * `FRAME_READY_TIMEOUT_DEFAULT_MS` silently — there is nothing to warn about
 * when the operator never set the var. A `raw` that IS set but blank,
 * non-numeric, zero, or negative falls back to the same default but with a
 * `warn`, since that shape indicates a typo'd or misconfigured override
 * rather than an intentional unset.
 */
export function resolveFrameReadyTimeoutMs(
  opts: { timeoutMs?: number } = {},
  raw: string | undefined = process.env.FRAME_READY_TIMEOUT_MS,
  log: Logger = logger
): number {
  if (opts.timeoutMs !== undefined) return opts.timeoutMs;
  if (raw === undefined) return FRAME_READY_TIMEOUT_DEFAULT_MS;

  const value = raw.trim();
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  if (value && !Number.isNaN(parsed) && parsed > 0) return parsed;

  log.warn(
    `FRAME_READY_TIMEOUT_MS=${JSON.stringify(raw)} is not a valid positive integer — falling back to ${FRAME_READY_TIMEOUT_DEFAULT_MS}ms`
  );
  return FRAME_READY_TIMEOUT_DEFAULT_MS;
}
