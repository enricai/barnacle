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

import { resolveDeepLocatorCandidates } from "@/scraper/deep-locator-candidates";
import { makeFakeFrameResolutionPage } from "@/scraper/deep-locator-fake";

/**
 * Pins {@link resolveScanFrameTarget}'s (`deep-locator-candidates.ts`)
 * internal `probeAttachedFrameTarget(page, frameSelector)` pass (perf-003,
 * `frame-target.ts`) — the seam a caller gets "for free" by passing only a
 * `frameSelector`, with no pre-resolved `timeoutOptions.frameTarget`. Every
 * case in `deep-locator-candidates.test.ts` either injects a ready-made
 * `frameTarget` (skipping this internal resolution entirely) or passes
 * `frameSelector: null` (short-circuiting it before any resolution attempt)
 * — this file is the only coverage of the internal pass actually running end
 * to end.
 *
 * Before perf-003, this seam ran `resolveFrameTarget(page, frameSelector,
 * { timeoutMs: 0 })`, whose every `withWatchdog`-guarded probe races the real
 * operation against a `setTimeout(fn, 0)` timer — a real CDP round-trip
 * always loses that race, so the "for free" fast path could never actually
 * land in production; only a same-tick fake `evaluate` could win it, which is
 * exactly what made that property untestable here (see git history for the
 * prior version of this docblock). `probeAttachedFrameTarget` closes that gap
 * with a real per-probe budget (`config.scraper.framePresenceProbeFloorMs`),
 * so case (a) below now proves the fast path lands against
 * {@link makeFakeFrameResolutionPage}'s latency-realistic fixture (a genuine
 * `setTimeout`-delayed probe, not a same-tick microtask) instead of only
 * asserting the observable degrade contract.
 */
describe("resolveDeepLocatorCandidates: internal resolveScanFrameTarget pass (no timeoutOptions.frameTarget)", () => {
  const FRAME_SELECTOR = "#talemetry_apply_iframe";
  const IFRAME_SRC = "https://apply.talemetry.com/application/abc-123";
  const PROBE_DELAY_MS = 5;

  /**
   * Minimal fake `page.evaluate`: answers `tryResolveChildFrame`'s
   * "read the iframe's src" probe (`frame-target.ts`) by extracting the CSS
   * selector the expression string was built with, mirroring
   * `frame-target.test.ts`'s `makeFakePage`. Resolves with no internal
   * `await` so it settles as a microtask, same-tick — used by cases (b) and
   * (c) below, whose degrade behavior doesn't depend on probe latency.
   */
  function makeIframeSrcProbe(iframes: Record<string, string>) {
    return async (expr: unknown) => {
      const match = /document\.querySelector\((.+?)\)/.exec(String(expr));
      const selector = match?.[1] ? (JSON.parse(match[1]) as string) : null;
      if (!selector || !Object.hasOwn(iframes, selector)) return { matched: false, src: null };
      return { matched: true, src: iframes[selector] ?? null };
    };
  }

  it("case (a): a latency-realistic Page whose iframe-src/location.href probes settle after a real timer tick (not same-tick) still takes the batched fast path via probeAttachedFrameTarget's real budget — one frame evaluate, zero delegate.count()/nth() calls", async () => {
    const scanEvaluateSpy = vi.fn().mockResolvedValue([
      { index: 0, text: "Manual Application", visible: true },
      { index: 1, text: "Cancel", visible: true },
    ]);
    const countSpy = vi.fn();
    const nthSpy = vi.fn();
    const { page } = makeFakeFrameResolutionPage({
      iframeSelector: FRAME_SELECTOR,
      childSrc: IFRAME_SRC,
      probeDelayMs: PROBE_DELAY_MS,
      onFrameEvaluate: scanEvaluateSpy,
    });
    // biome-ignore lint/suspicious/noExplicitAny: attaching a fake deepLocator beyond makeFakeFrameResolutionPage's Page surface
    (page as any).deepLocator = vi.fn().mockReturnValue({ count: countSpy, nth: nthSpy });

    const start = Date.now();
    const candidates = await resolveDeepLocatorCandidates(page, FRAME_SELECTOR, "*");
    const elapsed = Date.now() - start;

    expect(candidates).toEqual([
      {
        index: 0,
        selector: `deeplocator=${FRAME_SELECTOR} >> * >> nth=0`,
        accessibleText: "Manual Application",
      },
      {
        index: 1,
        selector: `deeplocator=${FRAME_SELECTOR} >> * >> nth=1`,
        accessibleText: "Cancel",
      },
    ]);
    expect(scanEvaluateSpy).toHaveBeenCalledTimes(1);
    expect(countSpy).not.toHaveBeenCalled();
    expect(nthSpy).not.toHaveBeenCalled();
    // Proves the batched fast path lands well within the probe's budget, without entering resolveFrameTarget's poll loop.
    expect(elapsed).toBeLessThan(1000);
  });

  it("case (b): a fake Page whose iframe probe reports no match degrades to the legacy loop — delegate.count() is called, candidates are still returned, and the call never throws", async () => {
    const countSpy = vi.fn().mockResolvedValue(1);
    const evaluateSpy = vi.fn(makeIframeSrcProbe({}));
    const page = {
      evaluate: evaluateSpy,
      frames: () => [],
      deepLocator: vi.fn().mockReturnValue({
        count: countSpy,
        nth: (index: number) => ({
          textContent: async () => (index === 0 ? "Manual Application" : ""),
        }),
      }),
    };

    const start = Date.now();
    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the resolveFrameTarget contract under test
      page as any,
      FRAME_SELECTOR,
      "*"
    );
    const elapsed = Date.now() - start;

    expect(candidates).toEqual([
      {
        index: 0,
        selector: `deeplocator=${FRAME_SELECTOR} >> * >> nth=0`,
        accessibleText: "Manual Application",
      },
    ]);
    // Proves the internal resolution pass actually ran (attempted the iframe-src
    // probe) rather than being skipped straight to the legacy loop.
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(1000);
  });

  it("case (c): a fake Page whose evaluate rejects still resolves via the legacy loop instead of propagating", async () => {
    const countSpy = vi.fn().mockResolvedValue(1);
    const evaluateSpy = vi.fn().mockRejectedValue(new Error("boom: CDP session torn down"));
    const page = {
      evaluate: evaluateSpy,
      frames: () => [],
      deepLocator: vi.fn().mockReturnValue({
        count: countSpy,
        nth: (index: number) => ({
          textContent: async () => (index === 0 ? "Manual Application" : ""),
        }),
      }),
    };

    const start = Date.now();
    const candidates = await resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the resolveFrameTarget contract under test
      page as any,
      FRAME_SELECTOR,
      "*"
    );
    const elapsed = Date.now() - start;

    expect(candidates).toEqual([
      {
        index: 0,
        selector: `deeplocator=${FRAME_SELECTOR} >> * >> nth=0`,
        accessibleText: "Manual Application",
      },
    ]);
    // Proves the internal resolution pass actually attempted the (rejecting)
    // iframe-src probe rather than being skipped straight to the legacy loop.
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(1000);
  });
});
