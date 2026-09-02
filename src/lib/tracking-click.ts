/**
 * Fire-and-forget background click for vendor click-tracking URLs.
 * After a successful submission, Barnacle navigates to the tracking URL
 * in a short-lived Browserbase session so the tracking vendor records the
 * Click event.
 *
 * Navigation pattern is proven against production click-tracking domains
 * with advancedStealth.
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
import { captureBeaconEvent } from "@/lib/telemetry/beacon-capture";
import { createBrowserSession } from "@/scraper/session";

const logger = getLogger({ name: "tracking-click" });

const NAVIGATE_TIMEOUT_MS = 30_000;
const SETTLE_WAIT_MS = 5_000;
const BROWSERBASE_SESSION_TIMEOUT_SECONDS = 300;

const inFlightClicks = new Set<Promise<void>>();

/**
 * The run's opaque reconciliation join keys, threaded through so a
 * beacon-fire outcome can be correlated back to its submit record. Optional
 * so existing `fireTrackingClick` call sites keep compiling unchanged.
 */
export interface TrackingClickReconciliationContext {
  requestId: string;
  joinKeys: Record<string, unknown> | null;
}

/**
 * Wraps `captureBeaconEvent` so a throwing/rejecting capture sink can never
 * propagate into the tracking-click fire-and-forget path — the same defense
 * `emitEnvelopeSafely` applies around `captureSubmissionEnvelope` in
 * loader.ts, since `captureBeaconEvent`'s own internal swallow can be
 * bypassed by a test double or an unexpected synchronous throw.
 */
async function captureBeaconOutcomeSafely(
  input: Parameters<typeof captureBeaconEvent>[0]
): Promise<void> {
  try {
    await captureBeaconEvent(input);
  } catch (err) {
    logger.warn(`beacon outcome capture failed: ${toErrorMessage(err)}`);
  }
}

/**
 * Resolves the given session's outbound IP for the beacon record. Never
 * throws — a resolution failure (or a session/provider without the
 * accessor) yields `null` rather than blocking the beacon write, matching
 * the same never-throw contract `getOutboundIp` itself already applies.
 */
async function resolveSessionIp(
  session: Awaited<ReturnType<typeof createBrowserSession>> | undefined
): Promise<string | null> {
  if (!session?.getOutboundIp) return null;
  try {
    return await session.getOutboundIp();
  } catch (err) {
    logger.warn(`tracking click session IP resolution failed: ${toErrorMessage(err)}`);
    return null;
  }
}

/**
 * Navigates a Browserbase session to the tracking URL. Errors are logged
 * and swallowed — the apply already succeeded, so a failed tracking click
 * is a monitoring concern, not a runtime failure.
 */
async function executeTrackingClick(
  trackingUrl: string,
  siteId: string,
  reconciliation?: TrackingClickReconciliationContext
): Promise<void> {
  const startedAt = Date.now();
  recordTrackingClickAttempt(siteId);

  let session: Awaited<ReturnType<typeof createBrowserSession>> | undefined;
  try {
    session = await createBrowserSession({
      provider: "browserbase",
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
    if (reconciliation) {
      await captureBeaconOutcomeSafely({
        requestId: reconciliation.requestId,
        siteId,
        joinKeys: reconciliation.joinKeys,
        beaconStatus: "fired",
        trackingUrl,
        durationMs: Date.now() - startedAt,
        sessionIp: await resolveSessionIp(session),
      });
    }
  } catch (err) {
    recordTrackingClickFailure(siteId, err instanceof Error ? err.constructor.name : "unknown");
    logger.warn(
      `tracking click failed site=${siteId} url=${trackingUrl.slice(0, 120)}: ${toErrorMessage(err)}`
    );
    if (reconciliation) {
      await captureBeaconOutcomeSafely({
        requestId: reconciliation.requestId,
        siteId,
        joinKeys: reconciliation.joinKeys,
        beaconStatus: "failed",
        trackingUrl,
        durationMs: Date.now() - startedAt,
        sessionIp: await resolveSessionIp(session),
      });
    }
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
 * does not await the result. Errors never propagate. `reconciliation` is
 * optional so a fired/failed beacon outcome can be correlated to the run
 * when the caller has resolved join keys; omit it to keep today's behavior.
 */
export function fireTrackingClick(
  trackingUrl: string,
  siteId: string,
  reconciliation?: TrackingClickReconciliationContext
): void {
  const promise = executeTrackingClick(trackingUrl, siteId, reconciliation).finally(() => {
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
