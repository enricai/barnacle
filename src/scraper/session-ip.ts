/**
 * Resolves a browser session's outbound IP by opening a throwaway top-level
 * tab and navigating it to an IP-echo endpoint. Neither the Browserbase SDK
 * nor Stagehand exposes a session's actual outbound IP anywhere else (session
 * create/get, logs, and recording endpoints all omit it) — having the session
 * itself hit an echo endpoint is the only way to learn it.
 *
 * Typed against a minimal page factory rather than `Stagehand`/`V3Context` so
 * it can be unit-tested with fakes, no CDP connection or network required.
 * Provider wiring (constructing the real factory from a live session) and
 * config plumbing for `echoUrl`/`timeoutMs` are out of scope here.
 */

import { isIP } from "node:net";

import { toErrorMessage } from "@/lib/errors";
import { withWatchdog } from "@/scraper/watchdog";
import type { Logger } from "@/types/logging";

/**
 * Minimal page surface this module needs — a structural subset of
 * Stagehand's `Page` (`goto`, `evaluate`, `close`) so a real `Page` instance
 * satisfies this type without casting, while tests can supply a fake with no
 * Stagehand dependency at all.
 */
export interface EchoPage {
  goto(url: string, options?: { waitUntil?: string; timeoutMs?: number }): Promise<unknown>;
  evaluate<R>(pageFunctionOrExpression: string): Promise<R>;
  close(): Promise<void>;
}

/**
 * Opens a new top-level tab and returns it. Production callers pass
 * `() => stagehand.context.newPage()`; the resolver never constructs a
 * Stagehand/CDP object itself.
 */
export type EchoPageFactory = () => Promise<EchoPage>;

/** Tuning knobs for {@link resolveSessionOutboundIp}. */
export interface SessionOutboundIpOptions {
  /**
   * IP-echo endpoint the tab navigates to. Caller-supplied (not defaulted
   * here) so an operator can point at a self-hosted echo endpoint instead of
   * a third-party one.
   */
  echoUrl: string;
  /**
   * Bound on the whole open+navigate+read sequence, enforced via
   * `withWatchdog`. A tab that never settles yields `null` instead of
   * blocking the caller forever.
   */
  timeoutMs: number;
  /** Optional logger for failure diagnostics; omitted call sites stay silent. */
  logger?: Logger;
}

const BODY_TEXT_EXPR = 'document.body ? document.body.innerText : ""';
const WATCHDOG_LABEL = "session-outbound-ip:echo";

/**
 * Extracts a validated IP from an echo endpoint's response body. Accepts
 * both `{"ip":"..."}` JSON (ipify's JSON mode) and a bare-text body (a
 * self-hosted plain-text echo) so the resolver isn't tied to one provider's
 * response shape. Returns `null` for anything that isn't a valid IPv4/IPv6
 * shape — most notably a captive-portal HTML page — rather than persisting
 * garbage as telemetry.
 */
function extractIpFromBody(body: string): string | null {
  const trimmed = body.trim();
  const candidate = ((): string => {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "ip" in parsed &&
        typeof (parsed as { ip: unknown }).ip === "string"
      ) {
        return (parsed as { ip: string }).ip.trim();
      }
    } catch {
      // not JSON — fall through to bare-text handling below
    }
    return trimmed;
  })();

  return isIP(candidate) !== 0 ? candidate : null;
}

/**
 * Opens a throwaway top-level tab via `newPage`, navigates it to
 * `opts.echoUrl`, and reads back whatever IP the echo endpoint reports as
 * this session's outbound address. Never throws — every failure path
 * (timeout, non-IP body, a thrown error from the page) resolves to `null`,
 * matching the swallow-all telemetry contract `captureSubmissionEnvelope`
 * holds elsewhere, since this value must never break a submission run.
 *
 * The tab is always closed, on every path, including the timeout path,
 * since `page` is captured as soon as `newPage()` resolves and closed in a
 * `finally` regardless of how the navigate/read step settles.
 *
 * Caveat: Browserbase does not document whether its managed residential
 * proxy pool is sticky per session, so callers should pair a resolved value
 * with a capture timestamp rather than assume it's stable for the run's
 * duration.
 */
export async function resolveSessionOutboundIp(
  newPage: EchoPageFactory,
  opts: SessionOutboundIpOptions
): Promise<string | null> {
  const { echoUrl, timeoutMs, logger } = opts;
  let page: EchoPage | undefined;

  try {
    return await withWatchdog(
      async () => {
        page = await newPage();
        await page.goto(echoUrl, { waitUntil: "domcontentloaded", timeoutMs });
        const body = await page.evaluate<string>(BODY_TEXT_EXPR);
        return extractIpFromBody(body);
      },
      { timeoutMs, label: WATCHDOG_LABEL }
    );
  } catch (err) {
    logger?.warn(`session outbound ip resolution failed: ${toErrorMessage(err)}`);
    return null;
  } finally {
    if (page) {
      await page.close().catch((closeErr: unknown) => {
        logger?.warn(`session outbound ip echo tab close failed: ${toErrorMessage(closeErr)}`);
      });
    }
  }
}
