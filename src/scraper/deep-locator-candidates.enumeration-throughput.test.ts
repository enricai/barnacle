import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { resolveDeepLocatorCandidates } from "@/scraper/deep-locator-candidates";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  makeFakeFrameScan,
  registerDeepLocatorHopElements,
  registerDeepLocatorHopLatency,
} from "@/scraper/deep-locator-fake";
import { withWatchdog } from "@/scraper/watchdog";

/** Matches `deep-locator-candidates.ts`'s `DEFAULT_DEEP_LOCATOR_ENUMERATION_BUDGET_MS` (not exported). */
const ENUMERATION_BUDGET_MS = 60_000;

/** The uchealth-7 measured per-candidate CDP round-trip cost through a proxied OOPIF. */
const MEASURED_ROUND_TRIP_MS = 4_600;

const HOP_SELECTOR = "#talemetry_apply_iframe >> *";

function build371ElementHop(frame: FakeDeepLocatorFrame) {
  return registerDeepLocatorHopElements(
    frame,
    HOP_SELECTOR,
    Array.from({ length: 371 }, (_, index) => `node-${index}`)
  );
}

/**
 * A `FrameTarget` whose batched `evaluate` resolves against `frame`'s
 * registered hop at the measured per-round-trip cost — the seam that lets a
 * test prove the batched-scan fix costs exactly one round-trip regardless of
 * candidate count, since a legacy per-candidate loop over 371 elements at
 * this same cost would blow the enumeration budget by two orders of
 * magnitude.
 */
function makeSlowFrameTarget(frame: FakeDeepLocatorFrame): {
  frameTarget: FrameTarget;
  evaluateSpy: ReturnType<typeof vi.fn>;
} {
  const evaluateSpy = vi.fn(makeFakeFrameScan(frame, HOP_SELECTOR));
  const frameTarget: FrameTarget = {
    frame: {} as unknown as FrameTarget["frame"],
    frameSelector: HOP_SELECTOR,
    declaredFrameSelector: HOP_SELECTOR,
    evaluate: evaluateSpy as unknown as FrameTarget["evaluate"],
    locator: () => {
      throw new Error("locator() is not used by resolveDeepLocatorCandidates");
    },
    url: async () => "",
    title: async () => "",
  };
  return { frameTarget, evaluateSpy };
}

/**
 * A `FrameTarget` whose batched `evaluate` never settles on its own —
 * models the single round-trip itself running long enough to blow the
 * enumeration budget (a huge payload over a slow proxied CDP link) —
 * wrapped in the same `withWatchdog` primitive `frame-target.ts`'s real
 * `childFrameTarget`/`mainFrameTarget` wrap every `evaluate` call in, so it
 * rejects once `ENUMERATION_BUDGET_MS` elapses instead of hanging forever.
 */
function makeNeverSettlingFrameTarget(): FrameTarget {
  return {
    frame: {} as unknown as FrameTarget["frame"],
    frameSelector: HOP_SELECTOR,
    declaredFrameSelector: HOP_SELECTOR,
    evaluate: () =>
      withWatchdog(() => new Promise<never>(() => {}), {
        timeoutMs: ENUMERATION_BUDGET_MS,
        label: `deepLocator batched scan for ${HOP_SELECTOR}`,
      }),
    locator: () => {
      throw new Error("locator() is not used by resolveDeepLocatorCandidates");
    },
    url: async () => "",
    title: async () => "",
  };
}

describe("resolveDeepLocatorCandidates enumeration throughput (uchealth-7 371-candidate hop)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loggerStub.warn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves all 371 candidates within the default 60s budget via a single frame round-trip, not one per candidate", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = build371ElementHop(frame);
    registerDeepLocatorHopLatency(hop, { delayOn: "scan", delayMs: MEASURED_ROUND_TRIP_MS });
    const { frameTarget, evaluateSpy } = makeSlowFrameTarget(frame);
    const page = { deepLocator: makeFakeDeepLocator(frame) };

    const promise = resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#talemetry_apply_iframe",
      "*",
      null,
      { frameTarget }
    );

    await vi.advanceTimersByTimeAsync(MEASURED_ROUND_TRIP_MS);
    const candidates = await promise;

    expect(candidates).toHaveLength(371);
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    expect(loggerStub.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("deepLocator enumeration")
    );
  });

  it("still honors the budget by aborting when the single batched call itself exceeds it, falling back to the legacy loop's own budget", async () => {
    const frame: FakeDeepLocatorFrame = new Map();
    const hop = build371ElementHop(frame);
    registerDeepLocatorHopLatency(hop, { delayOn: "textContent", delayMs: MEASURED_ROUND_TRIP_MS });
    const frameTarget = makeNeverSettlingFrameTarget();
    const page = { deepLocator: makeFakeDeepLocator(frame) };

    const promise = resolveDeepLocatorCandidates(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#talemetry_apply_iframe",
      "*",
      null,
      { frameTarget }
    );

    await vi.advanceTimersByTimeAsync(ENUMERATION_BUDGET_MS * 2 + MEASURED_ROUND_TRIP_MS);
    const candidates = await promise;

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThan(371);
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringContaining("deepLocator batched scan for")
    );
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringContaining("aborted after exceeding")
    );
  });
});
