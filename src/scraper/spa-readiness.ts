import type { Page } from "@browserbasehq/stagehand";

import { withWatchdog } from "@/scraper/watchdog";
import type { Logger } from "@/types/logging";

/** SPA-readiness gate defaults — match the recon CLI's post-navigation wait. */
const SPA_READINESS_TIMEOUT_MS = 15_000;
const SPA_READINESS_POLL_MS = 500;
const SPA_MIN_BODY_LENGTH = 5_000;

/**
 * Block until a just-navigated SPA has actually hydrated, so the flow does not
 * begin stepping against a shell page. `page.goto(..., "domcontentloaded")` on a
 * bot-managed/CDN-fronted single-page app resolves during the challenge/redirect —
 * before the client framework renders the real DOM — so the first steps would
 * otherwise probe an empty page, find no candidates, and (being optional) skip
 * the entire flow. The recon CLI has this gate inline; generated plugins call it
 * here so they inherit the same behavior. Polls `document.body.outerHTML.length`
 * up to a threshold, then proceeds regardless (best-effort, never throws).
 *
 * Each `document.body.outerHTML.length` read is itself bounded by a watchdog
 * (capped to one poll interval) and treated as "still 0 chars" on timeout —
 * same pattern as `waitForChildFrameReady`'s `isReady()` probe. Without this,
 * a single wedged CDP round-trip inside `readBodyLength` would pend forever
 * and the `while (Date.now() < deadline)` loop below would never be
 * re-entered, defeating the very deadline it exists to enforce.
 * `page.waitForTimeout(pollMs)` is left unguarded: it is a plain delay (no
 * DOM/network read whose response can be lost), so it does not carry the
 * "wedged read" failure mode this fix targets.
 */
export async function waitForSpaReady(
  page: Page,
  logger: Logger,
  opts: { timeoutMs?: number; pollMs?: number; minBodyLength?: number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? SPA_READINESS_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? SPA_READINESS_POLL_MS;
  const minBodyLength = opts.minBodyLength ?? SPA_MIN_BODY_LENGTH;
  const bodyLengthExpr = "document.body ? document.body.outerHTML.length : 0";

  const readBodyLength = async (): Promise<number> => {
    const raw = await withWatchdog(() => page.evaluate(bodyLengthExpr), {
      timeoutMs: pollMs,
      label: "flow-runner: spa readiness body-length probe",
    }).catch(() => 0);
    return typeof raw === "number" ? raw : 0;
  };

  let bodyLength = await readBodyLength();
  if (bodyLength >= minBodyLength) {
    return;
  }

  logger.info(
    `spa readiness: body ${bodyLength} chars < ${minBodyLength} threshold — waiting for SPA to render`
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs);
    bodyLength = await readBodyLength();
    if (bodyLength >= minBodyLength) {
      logger.info(`spa readiness: body grew to ${bodyLength} chars — SPA rendered`);
      return;
    }
  }
  logger.warn(
    `spa readiness: body still ${bodyLength} chars after ${timeoutMs}ms — proceeding with possibly incomplete page`
  );
}

/** Below this body length after the readiness wait, the page is treated as an empty shell. */
const SPA_EMPTY_SHELL_BODY_LENGTH = 1_000;

/**
 * Re-gate SPA hydration after a mid-flow origin change, with one reload of recovery.
 * `waitForSpaReady` proceeds silently on a shell page; a cross-origin hop that landed
 * on an empty shell (e.g. a redirect from app.example.com to login.example.net whose
 * client bundle never booted) would otherwise let every later step probe nothing.
 * Reloads at most once and never throws.
 */
export async function regateSpaAfterOriginChange(
  page: Page,
  logger: Logger,
  opts: { timeoutMs?: number; pollMs?: number; minBodyLength?: number } = {}
): Promise<void> {
  await waitForSpaReady(page, logger, opts);
  const bodyLength = await readBodyLengthOnce(page, opts.pollMs ?? SPA_READINESS_POLL_MS);
  if (bodyLength >= SPA_EMPTY_SHELL_BODY_LENGTH) {
    return;
  }
  logger.warn(
    `spa readiness: body ${bodyLength} chars < ${SPA_EMPTY_SHELL_BODY_LENGTH} after origin change — reloading once`
  );
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
  } catch (err) {
    logger.warn(
      `spa readiness: reload failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  await waitForSpaReady(page, logger, opts);
}

async function readBodyLengthOnce(page: Page, timeoutMs: number): Promise<number> {
  const raw = await withWatchdog(
    () => page.evaluate("document.body ? document.body.outerHTML.length : 0"),
    { timeoutMs, label: "flow-runner: spa origin re-gate body-length probe" }
  ).catch(() => 0);
  return typeof raw === "number" ? raw : 0;
}
