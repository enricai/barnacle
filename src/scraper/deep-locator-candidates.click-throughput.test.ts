/**
 * Pins `clickDeepLocatorCandidate`'s batched one-round-trip click actuation —
 * perf-003's absorbed half of this fix: collapsing the `index + 1` serial
 * `nth(index).click()` round-trips `resolveAtIndex` pays through the legacy
 * delegate (see `deep-locator-candidates.click-budget.test.ts`) into a
 * single `frameTarget.evaluate(buildClickFrameCandidateExpr(...))` call when
 * a frame seam is available. Every degrade path (stale index, a rejecting
 * evaluate, a non-conforming payload, no seam at all) must still land the
 * click via the legacy delegate rather than losing it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameTarget } from "@/scraper/frame-target";

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

import { clickDeepLocatorCandidate } from "@/scraper/deep-locator-candidates";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHopElements,
  registerDeepLocatorHopLatency,
} from "@/scraper/deep-locator-fake";
import { isNodeNotActionableError } from "@/scraper/deep-locator-scan";

const FRAME_SELECTOR = "#apply_frame";
const INNER_SELECTOR = "button";
const HOP_SELECTOR = `${FRAME_SELECTOR} >> ${INNER_SELECTOR}`;
const TARGET_INDEX = 40;

/** Builds a `FrameTarget` whose `evaluate` is a bare spy a test configures per scenario — the click-actuation counterpart to `deep-locator-candidates.test.ts`'s scan-side `makeFakeFrameTarget`. */
function makeFakeFrameTarget(evaluateImpl: (...args: unknown[]) => Promise<unknown>): {
  frameTarget: FrameTarget;
  evaluateSpy: ReturnType<typeof vi.fn>;
} {
  const evaluateSpy = vi.fn(evaluateImpl);
  const frameTarget: FrameTarget = {
    frame: {} as unknown as FrameTarget["frame"],
    frameSelector: FRAME_SELECTOR,
    declaredFrameSelector: FRAME_SELECTOR,
    evaluate: evaluateSpy as unknown as FrameTarget["evaluate"],
    locator: () => {
      throw new Error("locator() is not used by clickDeepLocatorCandidate");
    },
    url: async () => "",
    title: async () => "",
  };
  return { frameTarget, evaluateSpy };
}

function buildHopWithTarget() {
  const frame: FakeDeepLocatorFrame = new Map();
  const hop = registerDeepLocatorHopElements(
    frame,
    HOP_SELECTOR,
    Array.from({ length: TARGET_INDEX + 1 }, (_, index) => `candidate-${index}`)
  );
  const deepLocatorSpy = vi.fn(makeFakeDeepLocator(frame));
  const page = { deepLocator: deepLocatorSpy };
  return { hop, page, deepLocatorSpy };
}

describe("clickDeepLocatorCandidate batched click-by-index actuation", () => {
  beforeEach(() => {
    loggerStub.warn.mockClear();
  });

  it("clicking a candidate at index 40 costs exactly one frame evaluate and zero delegate round-trips, given a frameTarget", async () => {
    const { hop, page, deepLocatorSpy } = buildHopWithTarget();
    const { frameTarget, evaluateSpy } = makeFakeFrameTarget(async () => ({ clicked: true }));

    await clickDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      INNER_SELECTOR,
      TARGET_INDEX,
      { frameTarget }
    );

    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    expect(deepLocatorSpy).not.toHaveBeenCalled();
    expect(hop.elements[TARGET_INDEX]?.clicks).toBe(0);
  });

  it("with preferTrustedClick, SKIPS the synthetic batched click and activates exactly once via the trusted delegate (no double-fire)", async () => {
    const { hop, page, deepLocatorSpy } = buildHopWithTarget();
    const { frameTarget, evaluateSpy } = makeFakeFrameTarget(async () => ({ clicked: true }));

    await clickDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      INNER_SELECTOR,
      TARGET_INDEX,
      { frameTarget, preferTrustedClick: true }
    );

    // The synthetic batched click never ran (it would have been a second
    // activation — on a toggle that is select→deselect = net zero); only the
    // trusted delegate click fired, exactly once.
    expect(evaluateSpy).not.toHaveBeenCalled();
    expect(deepLocatorSpy).toHaveBeenCalledWith(HOP_SELECTOR);
    expect(hop.elements[TARGET_INDEX]?.clicks).toBe(1);
  });

  it("costs (index + 1) delegate round-trips through the legacy fallback when no frameTarget is available — the exact cost the batched path collapses", async () => {
    vi.useFakeTimers();
    try {
      const frame: FakeDeepLocatorFrame = new Map();
      const hop = registerDeepLocatorHopElements(
        frame,
        HOP_SELECTOR,
        Array.from({ length: TARGET_INDEX + 1 }, (_, index) => `candidate-${index}`)
      );
      registerDeepLocatorHopLatency(hop, { delayOn: "click", delayMs: 100 });
      const page = { deepLocator: makeFakeDeepLocator(frame) };

      let settled = false;
      clickDeepLocatorCandidate(
        // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
        page as any,
        FRAME_SELECTOR,
        INNER_SELECTOR,
        TARGET_INDEX
      ).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync((TARGET_INDEX + 1) * 100 - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(hop.elements[TARGET_INDEX]?.clicks).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with an error isNodeNotActionableError classifies as not-actionable when the batched click reports an unrendered node, without falling back to the delegate", async () => {
    const { hop, page, deepLocatorSpy } = buildHopWithTarget();
    const { frameTarget } = makeFakeFrameTarget(async () => ({
      clicked: false,
      reason: "not-actionable",
    }));

    let caught: unknown;
    try {
      await clickDeepLocatorCandidate(
        // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
        page as any,
        FRAME_SELECTOR,
        INNER_SELECTOR,
        TARGET_INDEX,
        { frameTarget }
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(isNodeNotActionableError(caught)).toBe(true);
    expect(deepLocatorSpy).not.toHaveBeenCalled();
    expect(hop.elements[TARGET_INDEX]?.clicks).toBe(0);
  });

  it("degrades to the legacy delegate click when the batched click reports a stale/out-of-range index", async () => {
    const { hop, page } = buildHopWithTarget();
    const { frameTarget } = makeFakeFrameTarget(async () => ({
      clicked: false,
      reason: "out-of-range",
    }));

    await clickDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      INNER_SELECTOR,
      TARGET_INDEX,
      { frameTarget }
    );

    expect(hop.elements[TARGET_INDEX]?.clicks).toBe(1);
  });

  it("degrades to the legacy delegate click when the batched evaluate call rejects", async () => {
    const { hop, page } = buildHopWithTarget();
    const { frameTarget } = makeFakeFrameTarget(async () => {
      throw new Error("evaluate wedged");
    });

    await clickDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      INNER_SELECTOR,
      TARGET_INDEX,
      { frameTarget }
    );

    expect(hop.elements[TARGET_INDEX]?.clicks).toBe(1);
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringContaining("deepLocator batched click for")
    );
  });

  it("degrades to the legacy delegate click when the batched evaluate resolves a non-conforming payload", async () => {
    const { hop, page } = buildHopWithTarget();
    const { frameTarget } = makeFakeFrameTarget(async () => [
      { index: 0, text: "", visible: true },
    ]);

    await clickDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      INNER_SELECTOR,
      TARGET_INDEX,
      { frameTarget }
    );

    expect(hop.elements[TARGET_INDEX]?.clicks).toBe(1);
    expect(loggerStub.warn).toHaveBeenCalledWith(expect.stringContaining("non-conforming payload"));
  });

  it("with no frameTarget supplied and no evaluate seam resolvable, behavior is byte-identical to the pre-batched legacy click", async () => {
    const { hop, page, deepLocatorSpy } = buildHopWithTarget();

    await clickDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      FRAME_SELECTOR,
      INNER_SELECTOR,
      TARGET_INDEX
    );

    expect(deepLocatorSpy).toHaveBeenCalledWith(HOP_SELECTOR);
    expect(hop.elements[TARGET_INDEX]?.clicks).toBe(1);
    expect(loggerStub.warn).not.toHaveBeenCalled();
  });
});
