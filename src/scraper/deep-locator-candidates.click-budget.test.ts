/**
 * Pins `clickDeepLocatorCandidate`'s legacy delegate fallback watchdog
 * scaling — the fix for the uchealth-7 finding that a candidate past index
 * ~14 (`resolveAtIndex(query, i)` costs `i + 1` serial CDP round-trips before
 * the click ever dispatches, understudy/selectorResolver.js:70,79-115) got
 * killed by a fixed single-round-trip `callTimeoutMs` even though the click
 * itself would have succeeded given enough budget. Every scenario here goes
 * through a bare fake `Page` (no `frames`/`evaluate`), so
 * `clickDeepLocatorCandidate`'s internal frame-seam resolution always fails
 * and the legacy delegate path — the one this fix scales — is exactly what
 * runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  }),
}));

import { clickDeepLocatorCandidate } from "@/scraper/deep-locator-candidates";
import {
  type FakeDeepLocatorFrame,
  makeFakeDeepLocator,
  registerDeepLocatorHopElements,
  registerDeepLocatorHopLatency,
} from "@/scraper/deep-locator-fake";

/** The uchealth-7 measured per-round-trip CDP cost through a proxied OOPIF (run-7: candidate 13 enumerated within a 60s budget, i.e. 91 cumulative round-trips → ~659ms/round-trip). */
const PER_ROUND_TRIP_MS = 659;

const HOP_SELECTOR = "#talemetry_apply_iframe >> button";

function buildHop(count: number) {
  const frame: FakeDeepLocatorFrame = new Map();
  const hop = registerDeepLocatorHopElements(
    frame,
    HOP_SELECTOR,
    Array.from({ length: count }, (_, index) => `candidate-${index}`)
  );
  registerDeepLocatorHopLatency(hop, { delayOn: "click", delayMs: PER_ROUND_TRIP_MS });
  const page = { deepLocator: makeFakeDeepLocator(frame) };
  return { frame, hop, page };
}

describe("clickDeepLocatorCandidate legacy-fallback watchdog scales with candidate index", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([0, 5, 14, 20, 40])(
    "resolves a click at index %i that settles after (index + 1) round-trips, at the default callTimeoutMs",
    async (index) => {
      const { page, hop } = buildHop(index + 1);

      const promise = clickDeepLocatorCandidate(
        // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
        page as any,
        "#talemetry_apply_iframe",
        "button",
        index
      );

      // Charged (index + 1) sequential round-trips by the fake delegate —
      // advance well past that so a correctly-scaled watchdog has time to
      // let the click settle rather than reject it early.
      await vi.advanceTimersByTimeAsync((index + 1) * PER_ROUND_TRIP_MS + 1);

      await expect(promise).resolves.toBeUndefined();
      expect(hop.elements[index]?.clicks).toBe(1);
    }
  );

  it("still rejects with WatchdogTimeoutError for a genuinely wedged click (never settles) at a high index, instead of waiting forever", async () => {
    // A hand-rolled delegate (not deep-locator-fake.ts's latency gate, which
    // models a finite per-call delay, not a true hang) whose click() never
    // settles on its own — the run-6 78-minute-hang shape, at a candidate
    // index deep enough that the un-scaled 10s default would have starved it
    // long before a real click even had a chance to land.
    const page = {
      deepLocator: () => ({
        nth: () => ({
          click: () => new Promise<void>(() => {}),
        }),
      }),
    };

    const promise = clickDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#talemetry_apply_iframe",
      "button",
      20,
      { callTimeoutMs: 50 }
    );
    const assertion = expect(promise).rejects.toMatchObject({ name: "WatchdogTimeoutError" });

    // Scaled budget at index 20 with callTimeoutMs 50 is 50 + 20 * (the
    // module's per-index constant) — comfortably under a minute even at a
    // generous per-index cost, so this is a safe upper bound for "the
    // watchdog fired" without depending on the constant's exact value.
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it("keeps the index-0 legacy-fallback budget exactly callTimeoutMs (no regression for the un-scaled case)", async () => {
    const { page } = buildHop(1);

    const promise = clickDeepLocatorCandidate(
      // biome-ignore lint/suspicious/noExplicitAny: fake Page surface for the delegate contract under test
      page as any,
      "#talemetry_apply_iframe",
      "button",
      0,
      { callTimeoutMs: PER_ROUND_TRIP_MS - 1 }
    );
    const assertion = expect(promise).rejects.toMatchObject({ name: "WatchdogTimeoutError" });

    await vi.advanceTimersByTimeAsync(PER_ROUND_TRIP_MS - 1);
    await assertion;
  });
});
