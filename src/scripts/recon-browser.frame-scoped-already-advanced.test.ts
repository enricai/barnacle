import { describe, expect, it } from "vitest";
import { type FrameTarget, readCurrentFrameUrl } from "@/scraper/frame-target";
import { hasPageAlreadyAdvancedPastStep } from "@/scripts/recon-browser";

/**
 * Offline acceptance regression pinning the replan-loop instance of the
 * wrong-URL-scope bug: `recon-browser.ts`'s pre-replan short-circuit feeds
 * `hasPageAlreadyAdvancedPastStep` a before/after URL pair. When a flow
 * declares a `frameSelector`, that pair must be scoped to the resolved child
 * frame (via `readCurrentFrameUrl`) rather than the top-level `page.url()` —
 * a signup wizard living entirely inside a same-origin iframe can advance
 * from one step to the next purely through an in-frame navigation, leaving
 * the wrapper page's own URL untouched the whole time.
 *
 * **What this pins:** the already-advanced predicate/call-site contract in
 * isolation — `hasPageAlreadyAdvancedPastStep` itself is a pure string-pair
 * comparator with no frame awareness of its own, so the fix lives entirely
 * in what URL pair the call site hands it. This test exercises that pair
 * via the real exported `readCurrentFrameUrl` seam against a mocked child
 * `FrameTarget`, confirming it resolves to the frame's own moved URL rather
 * than falling back to the wrapper's stationary `page.url()`.
 */

const WRAPPER_URL = "https://careers.example.org/apply";
const FRAME_STEP_2_URL = "https://forms.example.com/wizard/step-2";
const FRAME_STEP_3_URL = "https://forms.example.com/wizard/step-3";

function mockChildFrameTarget(url: string): FrameTarget {
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: "#apply_frame",
    declaredFrameSelector: "#apply_frame",
    url: () => Promise.resolve(url),
  } as unknown as FrameTarget;
}

describe("recon-browser replan short-circuit frame-scoped already-advanced (offline fixture)", () => {
  it("readCurrentFrameUrl resolves to the child frame's own URL, not the stationary wrapper page.url()", async () => {
    const frameTarget = mockChildFrameTarget(FRAME_STEP_2_URL);
    await expect(readCurrentFrameUrl({} as never, frameTarget)).resolves.toBe(FRAME_STEP_2_URL);
  });

  it("detects the frame already advanced past the failed step when the wrapper page.url() never moved", async () => {
    const urlAtStepStart = await readCurrentFrameUrl(
      {} as never,
      mockChildFrameTarget(FRAME_STEP_2_URL)
    );
    const urlAfterFailure = await readCurrentFrameUrl(
      {} as never,
      mockChildFrameTarget(FRAME_STEP_3_URL)
    );

    // The wrapper page's own URL is identical before and after — a top-level
    // page.url() comparison alone would see no advancement at all.
    expect(WRAPPER_URL).toBe(WRAPPER_URL);
    expect(hasPageAlreadyAdvancedPastStep(urlAtStepStart, urlAfterFailure)).toBe(true);
  });

  it("does not treat a same-origin-and-path query/hash-only change inside the frame as advancement", () => {
    expect(hasPageAlreadyAdvancedPastStep(FRAME_STEP_2_URL, `${FRAME_STEP_2_URL}?modal=open`)).toBe(
      false
    );
    expect(hasPageAlreadyAdvancedPastStep(FRAME_STEP_2_URL, `${FRAME_STEP_2_URL}#section`)).toBe(
      false
    );
  });

  it("regression guard: returns false when the frame has not moved, so the flow loop's replan path remains reachable", () => {
    expect(hasPageAlreadyAdvancedPastStep(FRAME_STEP_2_URL, FRAME_STEP_2_URL)).toBe(false);
  });
});
