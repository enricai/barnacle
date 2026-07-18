/**
 * Cookie-jar snapshot capture via CDP `Network.getAllCookies`. `document.cookie`
 * and Stagehand's own cookie helpers can't see HttpOnly cookies, and
 * `Page.getCookies`/`Network.getCookies` only return cookies scoped to the
 * current frame's URLs — a journey that navigated click.appcast.io ->
 * apply.appcast.io would miss the click-domain cookies once on the apply
 * page. `Network.getAllCookies` returns the whole-browser jar regardless of
 * the page's current URL, which is what attribution analysis needs.
 */

import type { Page } from "@browserbasehq/stagehand";

import { toErrorMessage } from "@/lib/errors";
import type { CookieJarSnapshot, CookieRecord } from "@/scripts/recon-shared";

type GetAllCookiesResponse = { cookies: CookieRecord[] };

/**
 * Reads the browser's complete cookie jar and returns it as a labeled
 * snapshot. Never throws — telemetry capture is best-effort, so a failed CDP
 * call yields a snapshot with an `error` field and an empty `cookies` array
 * rather than aborting the recon run.
 */
export async function captureCookieJarSnapshot(
  page: Page,
  label: string,
  phase: string,
  stepIndex: number
): Promise<CookieJarSnapshot> {
  const timestamp = new Date().toISOString();
  try {
    const result = await page.sendCDP<GetAllCookiesResponse>("Network.getAllCookies");
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
