/**
 * Shared apply-page navigation helper. Centralises the two-step pattern that
 * every site browser-flow repeats: await the active Stagehand page, then
 * navigate to the apply URL with domcontentloaded. Chatty pages never reach
 * networkidle, so hydration is left to waitForSpaReady in the caller.
 *
 * Scripts that interleave CDP listener wiring between awaitActivePage and goto
 * (recon-browser.ts, recon-generate.ts, etc.) must NOT use this helper — they
 * need the bare page reference before any navigation fires.
 */

import type { Page, Stagehand } from "@browserbasehq/stagehand";

import type { MetricsCollector } from "@/lib/dispatch-metrics";

/**
 * Awaits the active Stagehand page and navigates to `url` with
 * `waitUntil: "domcontentloaded"`. When a `MetricsCollector` is supplied, wraps
 * the goto in a `"navigate"` step so the caller's metrics include navigation
 * timing without each site having to repeat the bookkeeping.
 */
export async function navigateActivePage(
  stagehand: Stagehand,
  url: string,
  collector?: MetricsCollector,
  timeoutMs?: number
): Promise<Page> {
  const page = await stagehand.context.awaitActivePage();
  collector?.startStep("navigate");
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    ...(timeoutMs !== undefined && { timeoutMs }),
  });
  collector?.endStep("success");
  return page;
}
