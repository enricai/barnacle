import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { snapshotPage } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

const FRAME_SELECTOR = "iframe#apply_frame";
const CHILD_ORIGIN = "https://apply.example.com";
const BASELINE_URL = `${CHILD_ORIGIN}/application/abc-123`;
const POST_NAV_URL = `${CHILD_ORIGIN}/application/abc-123/thank-you`;

/**
 * Reproduces the generic (non-captcha) counterpart of the bug fixed for
 * `waitForCaptchaNavigation`: `snapshotPage`'s post-action read is the
 * shared pre/post URL source for every submit/advance step's `urlChanged`
 * signal, not just the captcha-gated one. A resolved child `FrameTarget`
 * whose `url()` rejects transiently right after a same-origin internal
 * navigation (the OOPIF detach/reattach churn a submit click can trigger)
 * must still surface the frame's real post-navigation URL via
 * `readCurrentFrameUrl`'s re-resolution against `declaredFrameSelector`,
 * not fall through to the stale wrapper `page.url()`.
 */
describe("flow-runner/snapshotPage — generic submit/advance step survives a transiently-rejecting frame url() read", () => {
  it("reports the frame's real post-navigation URL instead of the stale page.url() when the resolved child FrameTarget's url() rejects once", async () => {
    const postNavFrame = {
      frameId: "child-post-nav",
      evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
        if (String(expr) === "location.href") return POST_NAV_URL;
        return null;
      }),
      locator: vi.fn(),
    } as unknown as ReturnType<Page["frames"]>[number];

    const page = {
      evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
        const src = String(expr);
        // tryResolveChildFrame's iframe-src probe, run when readCurrentFrameUrl
        // re-resolves the declared frame selector after the child target's
        // own url() rejects.
        if (src.includes("IFRAME")) {
          return { matched: true, src: POST_NAV_URL };
        }
        return null;
      }),
      frames: vi.fn().mockReturnValue([postNavFrame]),
      mainFrameId: vi.fn().mockReturnValue("main"),
      // The stale wrapper page URL: it never advances, so a fallback to it
      // would wrongly report urlChanged=false for the plain submit/advance step.
      url: () => BASELINE_URL,
    } as unknown as Page;

    let urlCallCount = 0;
    const childTarget: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: FRAME_SELECTOR,
      declaredFrameSelector: FRAME_SELECTOR,
      evaluate: vi.fn().mockResolvedValue({ html: 0, text: "0:" }) as FrameTarget["evaluate"],
      locator: vi.fn() as unknown as FrameTarget["locator"],
      url: vi.fn().mockImplementation(() => {
        urlCallCount += 1;
        return urlCallCount === 1
          ? Promise.resolve(BASELINE_URL)
          : Promise.reject(new Error("frame detached: in-frame navigation tore down the context"));
      }),
      title: vi.fn().mockResolvedValue(""),
    };

    const signalCounter = { n: 0 };

    const preSnapshot = await snapshotPage(childTarget, signalCounter, page);
    expect(preSnapshot.url).toBe(BASELINE_URL);

    const postSnapshot = await snapshotPage(childTarget, signalCounter, page);
    expect(postSnapshot.url).toBe(POST_NAV_URL);
    expect(postSnapshot.url).not.toBe(BASELINE_URL);
  });
});
