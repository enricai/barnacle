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

/** Max wait for the declared data call after a navigateTo goto; override via env. */
export const NAVIGATE_SETTLE_TIMEOUT_MS = Number(process.env.NAVIGATE_SETTLE_TIMEOUT_MS) || 15_000;
/** Quiet window after the matching capture with no further matching capture. */
export const NAVIGATE_SETTLE_QUIET_MS = Number(process.env.NAVIGATE_SETTLE_QUIET_MS) || 1_000;

/** Tracks completed captures (URL + request body) so a navigate step can settle on one. */
export interface CaptureTracker {
  observe(url: string, body: string | null | undefined, method?: string): void;
  /** Starts a settle window; only captures observed after this call count. */
  begin(matcher: { endpointRx: RegExp; bodyRx: RegExp | null }): NavigateSettleWait;
}

export interface NavigateSettleWait {
  wait(opts?: { timeoutMs?: number; quietMs?: number }): Promise<"settled" | "timeout">;
}

/** Hook accepted by executeNavigateStep: called before goto, returns a waiter. */
export type NavigateSettle = () => NavigateSettleWait;

export function createCaptureTracker(): CaptureTracker {
  const waiters = new Set<(url: string, body: string, bodyless: boolean) => void>();
  return {
    observe(url, body, method) {
      // A CORS preflight (OPTIONS) is not the data call. When the method is
      // unknown, a body-less capture is treated as a preflight too.
      const m = method?.toUpperCase();
      if (m === "OPTIONS") return;
      const bodyless = (m === undefined || m === "") && (body === null || body === undefined);
      if (bodyless) return;
      for (const w of [...waiters]) w(url, body ?? "", false);
    },
    begin({ endpointRx, bodyRx }) {
      let matchedAt: number | null = null;
      let wake: (() => void) | null = null;
      const listener = (url: string, body: string, _bodyless: boolean): void => {
        if (!endpointRx.test(url)) return;
        if (bodyRx !== null && !bodyRx.test(body)) return;
        matchedAt = Date.now();
        wake?.();
      };
      waiters.add(listener);
      return {
        async wait(opts) {
          const timeoutMs = opts?.timeoutMs ?? NAVIGATE_SETTLE_TIMEOUT_MS;
          const quietMs = opts?.quietMs ?? NAVIGATE_SETTLE_QUIET_MS;
          const deadline = Date.now() + timeoutMs;
          try {
            for (;;) {
              const now = Date.now();
              if (matchedAt !== null && now - matchedAt >= quietMs) return "settled";
              if (now >= deadline) return "timeout";
              const next = matchedAt !== null ? matchedAt + quietMs : deadline;
              await new Promise<void>((r) => {
                const t = setTimeout(r, Math.max(5, Math.min(next, deadline) - now));
                wake = () => {
                  clearTimeout(t);
                  r();
                };
              });
            }
          } finally {
            waiters.delete(listener);
          }
        },
      };
    },
  };
}

/** Builds a settle hook from declared patterns; undefined when no endpoint pattern (no wait). */
export function buildNavigateSettle(
  tracker: CaptureTracker,
  endpointPattern: string | null | undefined,
  bodyPattern?: string | null
): NavigateSettle | undefined {
  if (endpointPattern == null) return undefined;
  const endpointRx = new RegExp(endpointPattern);
  const bodyRx = bodyPattern != null ? new RegExp(bodyPattern) : null;
  return () => tracker.begin({ endpointRx, bodyRx });
}
