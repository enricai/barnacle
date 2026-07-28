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

/**
 * Pins {@link resolveScanFrameTarget}'s (`deep-locator-candidates.ts`)
 * internal `resolveFrameTarget(page, frameSelector, { timeoutMs: 0 })` pass —
 * the seam a caller gets "for free" by passing only a `frameSelector`, with
 * no pre-resolved `timeoutOptions.frameTarget`. Every case in
 * `deep-locator-candidates.test.ts` either injects a ready-made `frameTarget`
 * (skipping this internal resolution entirely) or passes `frameSelector:
 * null` (short-circuiting it before any resolution attempt) — this file is
 * the only coverage of the internal pass actually running end to end.
 *
 * `timeoutMs: 0` means `resolveFrameTarget`'s every `withWatchdog`-guarded
 * probe races the real operation against a `setTimeout(fn, 0)` timer. A
 * `setTimeout` callback is always a macrotask, so a fake `evaluate`/
 * `frames()[].evaluate` that resolves synchronously (no internal `await`,
 * settling as a microtask) still wins that race and lets the batched fast
 * path land — case (a) below. Under real CDP latency (a genuine async
 * round-trip, not a same-tick fake), this same zero-budget pass will always
 * lose the race and degrade to the legacy loop instead: that's a latency
 * property of the production Stagehand `Page`, not something a fake-Page
 * unit test can pin either way, so this file only asserts the *observable
 * contract* — never throws, degrades cleanly to the legacy loop, never polls
 * — and leaves the "does it win in production" question to the fix-owning
 * domain.
 */
describe("resolveDeepLocatorCandidates: internal resolveScanFrameTarget pass (no timeoutOptions.frameTarget)", () => {
  const FRAME_SELECTOR = "#talemetry_apply_iframe";
  const IFRAME_SRC = "https://apply.talemetry.com/application/abc-123";

  /**
   * Minimal fake `page.evaluate`: answers `tryResolveChildFrame`'s
   * "read the iframe's src" probe (`frame-target.ts`) by extracting the CSS
   * selector the expression string was built with, mirroring
   * `frame-target.test.ts`'s `makeFakePage`. Resolves with no internal
   * `await` so it settles as a microtask, same-tick — required to win the
   * `timeoutMs: 0` race at all (see the module docblock above).
   */
  function makeIframeSrcProbe(iframes: Record<string, string>) {
    return async (expr: unknown) => {
      const match = /document\.querySelector\((.+?)\)/.exec(String(expr));
      const selector = match?.[1] ? (JSON.parse(match[1]) as string) : null;
      if (!selector || !Object.hasOwn(iframes, selector)) return { matched: false, src: null };
      return { matched: true, src: iframes[selector] ?? null };
    };
  }

  /**
   * Fake child `Frame`: `evaluate("location.href")` answers the frame-origin
   * match `tryResolveChildFrame` performs while resolving, and any other
   * expression (the batched scan's `buildScanFrameCandidatesExpr` call) is
   * answered by `scanEvaluateSpy` so a test can assert the batched fast path
   * ran exactly once, distinctly from the resolution-time `location.href`
   * probe.
   */
  function makeFakeChildFrame(url: string, elements: Array<{ text: string; visible?: boolean }>) {
    const scanEvaluateSpy = vi.fn().mockResolvedValue(
      elements.map((element, index) => ({
        index,
        text: element.text,
        visible: element.visible ?? true,
      }))
    );
    return {
      frame: {
        evaluate: async (expr: unknown) => (expr === "location.href" ? url : scanEvaluateSpy(expr)),
      },
      scanEvaluateSpy,
    };
  }

  it("case (a): a fake Page whose evaluate/frames() resolve the child frame within the zero-budget race takes the batched fast path — one frame evaluate, zero delegate.count()/nth() calls", async () => {
    const { frame: childFrame, scanEvaluateSpy } = makeFakeChildFrame(IFRAME_SRC, [
      { text: "Manual Application" },
      { text: "Cancel" },
    ]);
    const countSpy = vi.fn();
    const nthSpy = vi.fn();
    const page = {
      evaluate: makeIframeSrcProbe({ [FRAME_SELECTOR]: IFRAME_SRC }),
      frames: () => [childFrame],
      deepLocator: vi.fn().mockReturnValue({ count: countSpy, nth: nthSpy }),
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
      {
        index: 1,
        selector: `deeplocator=${FRAME_SELECTOR} >> * >> nth=1`,
        accessibleText: "Cancel",
      },
    ]);
    expect(scanEvaluateSpy).toHaveBeenCalledTimes(1);
    expect(countSpy).not.toHaveBeenCalled();
    expect(nthSpy).not.toHaveBeenCalled();
    // Proves the zero-budget internal resolution never enters resolveFrameTarget's poll loop.
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
