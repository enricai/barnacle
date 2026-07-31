/**
 * Fire-and-forget background click for Appcast vivclid tracking URLs.
 * After a successful submission, Barnacle navigates to the tracking URL
 * in a short-lived Browserbase session so Appcast records the Click event.
 *
 * Navigation pattern is proven against click.appcast.io with advancedStealth.
 * No CDP behavioral signals are needed; those are only required when extracting
 * DataDome tokens for subsequent Node HTTP requests.
 */

import {
  recordTrackingClickAttempt,
  recordTrackingClickDuration,
  recordTrackingClickFailure,
  recordTrackingClickSuccess,
} from "@/lib/dd-metrics";
import { toErrorMessage } from "@/lib/errors";
import { getLogger } from "@/lib/logging";
import { createBrowserbaseBrowserSession } from "@/scraper/session-browserbase";

const logger = getLogger({ name: "tracking-click" });

const NAVIGATE_TIMEOUT_MS = 30_000;
const SETTLE_WAIT_MS = 5_000;
const BROWSERBASE_SESSION_TIMEOUT_SECONDS = 300;

const inFlightClicks = new Set<Promise<void>>();

/**
 * Navigates a Browserbase session to the tracking URL. Errors are logged
 * and swallowed — the apply already succeeded, so a failed tracking click
 * is a monitoring concern, not a runtime failure.
 */
async function executeTrackingClick(trackingUrl: string, siteId: string): Promise<void> {
  const startedAt = Date.now();
  recordTrackingClickAttempt(siteId);

  let session: Awaited<ReturnType<typeof createBrowserbaseBrowserSession>> | undefined;
  try {
    session = await createBrowserbaseBrowserSession({
      advancedStealth: true,
      browserbaseSessionCreateParams: { timeout: BROWSERBASE_SESSION_TIMEOUT_SECONDS },
    });
    const page = await session.stagehand.context.awaitActivePage();
    await page.goto(trackingUrl, { waitUntil: "domcontentloaded", timeoutMs: NAVIGATE_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_WAIT_MS);

    recordTrackingClickSuccess(siteId);
    logger.info(
      `tracking click success site=${siteId} url=${trackingUrl.slice(0, 120)} durationMs=${Date.now() - startedAt}`
    );
  } catch (err) {
    recordTrackingClickFailure(siteId, err instanceof Error ? err.constructor.name : "unknown");
    logger.warn(
      `tracking click failed site=${siteId} url=${trackingUrl.slice(0, 120)}: ${toErrorMessage(err)}`
    );
  } finally {
    recordTrackingClickDuration(siteId, Date.now() - startedAt);
    if (session) {
      await session.close().catch((closeErr) => {
        logger.warn(`tracking click session close failed: ${toErrorMessage(closeErr)}`);
      });
    }
  }
}

/**
 * Launches a background tracking click. Returns immediately — the caller
 * does not await the result. Errors never propagate.
 */
export function fireTrackingClick(trackingUrl: string, siteId: string): void {
  const promise = executeTrackingClick(trackingUrl, siteId).finally(() => {
    inFlightClicks.delete(promise);
  });
  inFlightClicks.add(promise);
}

/**
 * Awaits all in-flight tracking clicks, used during graceful shutdown to
 * prevent Browserbase session leaks on SIGTERM.
 */
export async function drainTrackingClicks(timeoutMs = 20_000): Promise<void> {
  if (inFlightClicks.size === 0) return;
  logger.info(`draining ${inFlightClicks.size} in-flight tracking click(s)`);
  await Promise.race([
    Promise.allSettled([...inFlightClicks]),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
