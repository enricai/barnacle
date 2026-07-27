/**
 * Cookie-jar snapshot capture via CDP `Network.getAllCookies`. `document.cookie`
 * and Stagehand's own cookie helpers can't see HttpOnly cookies, and
 * `Page.getCookies`/`Network.getCookies` only return cookies scoped to the
 * current frame's URLs — a journey that navigated a click-tracking domain ->
 * an apply domain would miss the click-domain cookies once on the apply
 * page. `Network.getAllCookies` returns the whole-browser jar regardless of
 * the page's current URL, which is what attribution analysis needs.
 */

import type { Page } from "@browserbasehq/stagehand";

import { toErrorMessage } from "@/lib/errors";
import { withWatchdog } from "@/scraper/watchdog";
import type { CookieJarSnapshot, CookieRecord } from "@/scripts/recon-shared";

type GetAllCookiesResponse = { cookies: CookieRecord[] };

/** Default budget for the `Network.getAllCookies` CDP call, see {@link captureCookieJarSnapshot}. */
const DEFAULT_COOKIE_JAR_TIMEOUT_MS = 5_000;

/** Tuning knobs for {@link captureCookieJarSnapshot}. */
export interface CookieJarTimeoutOptions {
  /** Milliseconds to wait for the CDP call before degrading to an error snapshot. */
  timeoutMs?: number;
}

/**
 * Reads the browser's complete cookie jar and returns it as a labeled
 * snapshot. Never throws — telemetry capture is best-effort, so a failed or
 * wedged CDP call (bounded by `timeoutOptions.timeoutMs`) yields a snapshot
 * with an `error` field and an empty `cookies` array rather than blocking or
 * aborting the recon run.
 */
export async function captureCookieJarSnapshot(
  page: Page,
  label: string,
  phase: string,
  stepIndex: number,
  timeoutOptions: CookieJarTimeoutOptions = {}
): Promise<CookieJarSnapshot> {
  const timestamp = new Date().toISOString();
  const timeoutMs = timeoutOptions.timeoutMs ?? DEFAULT_COOKIE_JAR_TIMEOUT_MS;
  try {
    const result = await withWatchdog(
      () => page.sendCDP<GetAllCookiesResponse>("Network.getAllCookies"),
      { timeoutMs, label: "cookie-jar Network.getAllCookies" }
    );
    return {
      label,
      phase,
      stepIndex,
      timestamp,
      cookies: result.cookies,
    };
  } catch (err) {
    return {
      label,
      phase,
      stepIndex,
      timestamp,
      cookies: [],
      error: toErrorMessage(err),
    };
  }
}
