/**
 * CDP behavioral-signal dispatcher. Sends synthetic mouse-move and scroll
 * events to give bot-detection scripts (e.g. DataDome's tags.js) the UI
 * signals they need to complete fingerprint computation. Without these,
 * passive page loads produce zero events, causing tags.js to delay or refuse
 * fingerprint resolution. Verified 2026-06-20: 0% resolution without signals
 * → 67%+ with CDP mouseMoved + scroll dispatched during the poll loop.
 */

import type { Page } from "@browserbasehq/stagehand";

/**
 * Dispatches two synthetic mouseMoved CDP events and a window.scrollBy(0,50)
 * on `page`. Call once per poll iteration inside any warmup loop that needs
 * DataDome (or similar) fingerprint resolution.
 */
export async function dispatchBehavioralSignals(page: Page): Promise<void> {
  await page.sendCDP("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 100 + Math.random() * 400,
    y: 200 + Math.random() * 300,
  });
  await page.sendCDP("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 300 + Math.random() * 200,
    y: 100 + Math.random() * 400,
  });
  await page.evaluate("window.scrollBy(0, 50)");
}
