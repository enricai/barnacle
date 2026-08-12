import { describe, expect, it, vi } from "vitest";

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({
  getLogger: () => loggerStub,
}));

import {
  fillDeepLocatorCandidate,
  selectDeepLocatorCandidateOption,
} from "@/scraper/deep-locator-actuate";
import { makeFakeFrameResolutionPage } from "@/scraper/deep-locator-fake";

/**
 * Pins {@link resolveActuateFrameTarget}'s (`deep-locator-actuate.ts`)
 * internal `probeAttachedFrameTarget(page, frameSelector)` pass (perf-003,
 * `frame-target.ts`) — the seam a caller gets "for free" by passing only a
 * `frameSelector`, with no pre-resolved `timeoutOptions.frameTarget`. Every
 * case in `deep-locator-actuate.test.ts` that resolves through the batched
 * fast path injects a ready-made `frameTarget`, skipping this internal
 * resolution entirely; the one case that DOES exercise it (`"with no
 * frameTarget supplied and no evaluate seam resolvable, behaves
 * byte-identically to the pre-batched delegate path"`) only proves the
 * degrade-to-legacy contract, since its fake `Page` has no `evaluate`/
 * `frames` at all. This file is the only coverage of the internal pass
 * actually landing the batched fast path end to end, matching
 * `deep-locator-candidates.internal-frame-resolution.test.ts`'s case (a) —
 * see that file's docblock for why `probeAttachedFrameTarget`'s real
 * per-probe budget (as opposed to the pre-perf-003
 * `resolveFrameTarget(page, frameSelector, { timeoutMs: 0 })` pass) is what
 * makes this provable against a latency-realistic fixture instead of only a
 * same-tick fake.
 */
describe("fillDeepLocatorCandidate/selectDeepLocatorCandidateOption: internal resolveActuateFrameTarget pass (no timeoutOptions.frameTarget)", () => {
  const FRAME_SELECTOR = "#apply_frame";
  const IFRAME_SRC = "https://apply.example.com/application/abc-123";
  const INNER_SELECTOR = "input";
  const TARGET_INDEX = 1;
  const PROBE_DELAY_MS = 5;

  it("fillDeepLocatorCandidate: a latency-realistic Page whose iframe-src/location.href probes settle after a real timer tick still takes the batched fast path via probeAttachedFrameTarget's real budget — two frame evaluates (write + stuck-confirm), zero delegate nth() calls", async () => {
    const fillEvaluateSpy = vi.fn(async (expression: unknown) =>
      typeof expression === "string" &&
      expression.includes("querySelectorAll") &&
      !expression.includes("dispatchEvent")
        ? { value: "Ada" }
        : { written: true, readBack: "Ada" }
    );
    const nthSpy = vi.fn();
    const { page } = makeFakeFrameResolutionPage({
      iframeSelector: FRAME_SELECTOR,
      childSrc: IFRAME_SRC,
      probeDelayMs: PROBE_DELAY_MS,
      onFrameEvaluate: fillEvaluateSpy,
    });
    // biome-ignore lint/suspicious/noExplicitAny: attaching a fake deepLocator beyond makeFakeFrameResolutionPage's Page surface
    (page as any).deepLocator = vi.fn().mockReturnValue({ nth: nthSpy });

    const start = Date.now();
    const result = await fillDeepLocatorCandidate(
      page,
      FRAME_SELECTOR,
      INNER_SELECTOR,
      TARGET_INDEX,
      "Ada"
    );
    const elapsed = Date.now() - start;

    expect(result).toBe(true);
    expect(fillEvaluateSpy).toHaveBeenCalledTimes(2);
    expect(nthSpy).not.toHaveBeenCalled();
    // Proves the batched fast path lands well within the probe's budget, without entering resolveFrameTarget's poll loop.
    expect(elapsed).toBeLessThan(1000);
  });

  it("selectDeepLocatorCandidateOption: a latency-realistic Page whose iframe-src/location.href probes settle after a real timer tick still takes the batched fast path via probeAttachedFrameTarget's real budget — two frame evaluates (write + stuck-confirm), zero delegate nth() calls", async () => {
    const selectEvaluateSpy = vi.fn(async (expression: unknown) =>
      typeof expression === "string" &&
      expression.includes("querySelectorAll") &&
      !expression.includes("dispatchEvent")
        ? { value: "US" }
        : { written: true, readBack: "US" }
    );
    const nthSpy = vi.fn();
    const { page } = makeFakeFrameResolutionPage({
      iframeSelector: FRAME_SELECTOR,
      childSrc: IFRAME_SRC,
      probeDelayMs: PROBE_DELAY_MS,
      onFrameEvaluate: selectEvaluateSpy,
    });
    // biome-ignore lint/suspicious/noExplicitAny: attaching a fake deepLocator beyond makeFakeFrameResolutionPage's Page surface
    (page as any).deepLocator = vi.fn().mockReturnValue({ nth: nthSpy });

    const start = Date.now();
    const result = await selectDeepLocatorCandidateOption(
      page,
      FRAME_SELECTOR,
      "select",
      TARGET_INDEX,
      "United States"
    );
    const elapsed = Date.now() - start;

    expect(result).toBe(true);
    expect(selectEvaluateSpy).toHaveBeenCalledTimes(2);
    expect(nthSpy).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(1000);
  });
});
