/**
 * CDP behavioral-signal dispatcher. Sends synthetic mouse-move and scroll
 * events to give bot-detection scripts (e.g. DataDome's tags.js) the UI
 * signals they need to complete fingerprint computation. Without these,
 * passive page loads produce zero events, causing tags.js to delay or refuse
 * fingerprint resolution. Verified 2026-06-20: 0% resolution without signals
 * → 67%+ with CDP mouseMoved + scroll dispatched during the poll loop.
 */

import type { Page } from "@browserbasehq/stagehand";

import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Dispatches two synthetic mouseMoved CDP events and a window.scrollBy(0,50)
 * on `page`, or on `frameTarget` when given a `FrameTarget` bound to a
 * resolved cross-origin child frame. Call once per poll iteration inside any
 * warmup loop that needs DataDome (or similar) fingerprint resolution —
 * `frameTarget` lets callers whose bot-detection warmup happens inside an
 * OOPIF (e.g. a cross-origin OOPIF apply wizard) target the frame's own CDP
 * session instead of the top-level one. Omitting `frameTarget`, or passing
 * one resolved to the main frame (`frame: null`), preserves today's
 * main-session behavior exactly.
 */
export async function dispatchBehavioralSignals(
  page: Page,
  frameTarget?: FrameTarget
): Promise<void> {
  const session = frameTarget?.frame?.session;
  const dispatchMouseEvent = session
    ? (params: object) => session.send("Input.dispatchMouseEvent", params)
    : (params: object) => page.sendCDP("Input.dispatchMouseEvent", params);

  await dispatchMouseEvent({
    type: "mouseMoved",
    x: 100 + Math.random() * 400,
    y: 200 + Math.random() * 300,
  });
  await dispatchMouseEvent({
    type: "mouseMoved",
    x: 300 + Math.random() * 200,
    y: 100 + Math.random() * 400,
  });
  await (frameTarget?.evaluate("window.scrollBy(0, 50)") ??
    page.evaluate("window.scrollBy(0, 50)"));
}
