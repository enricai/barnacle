import { describe, expect, it } from "vitest";
import { settleAfterClick } from "@/scraper/click-settle";

const MAX_MS = 15000;

function makeClock(onTick: (nowMs: number, counter: { n: number }) => void): {
  page: { waitForTimeout: (ms: number) => Promise<void> };
  counter: { n: number };
  now: () => number;
} {
  const counter = { n: 0 };
  let now = 0;
  const page = {
    waitForTimeout: async (ms: number): Promise<void> => {
      now += ms;
      onTick(now, counter);
    },
  };
  return { page, counter, now: () => now };
}

describe("settleAfterClick virtual clock", () => {
  it("returns well before the max when no activity is ever observed", async () => {
    const c = makeClock(() => {});
    await settleAfterClick(c.page, c.counter, 0);
    expect(c.now()).toBeGreaterThan(0);
    expect(c.now()).toBeLessThan(MAX_MS);
  });

  it("stops at the max on a continuous stream and not later", async () => {
    const c = makeClock((_, counter) => {
      counter.n += 1;
    });
    await settleAfterClick(c.page, c.counter, 0);
    expect(c.now()).toBe(MAX_MS);
  });

  it("waits for quiet after late activity instead of running to the max", async () => {
    const c = makeClock((now, counter) => {
      if (now === 6000) counter.n += 1;
    });
    await settleAfterClick(c.page, c.counter, 0);
    expect(c.now()).toBeGreaterThan(6000);
    expect(c.now()).toBeLessThan(MAX_MS);
  });
});
