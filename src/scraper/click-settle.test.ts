import { describe, expect, it } from "vitest";
import { settleAfterClick } from "@/scraper/click-settle";

function makeFake(onPoll: (polls: number, counter: { n: number }) => void): {
  page: { waitForTimeout: (ms: number) => Promise<void> };
  counter: { n: number };
  polls: () => number;
} {
  const counter = { n: 0 };
  let polls = 0;
  const page = {
    waitForTimeout: async (): Promise<void> => {
      polls += 1;
      onPoll(polls, counter);
    },
  };
  return { page, counter, polls: () => polls };
}

describe("settleAfterClick", () => {
  it("returns after activity at ~6s plus quiet polls", async () => {
    const f = makeFake((p, c) => {
      if (p === 6) c.n += 1;
    });
    await settleAfterClick(f.page, f.counter, 0);
    expect(f.polls()).toBe(9);
  });

  it("returns after activity at ~11s plus quiet polls", async () => {
    const f = makeFake((p, c) => {
      if (p === 11) c.n += 1;
    });
    await settleAfterClick(f.page, f.counter, 0);
    expect(f.polls()).toBe(14);
  });

  it("gives up when no activity ever appears", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(f.page, f.counter, 0);
    expect(f.polls()).toBe(14);
  });

  it("stops at the max on a continuous stream", async () => {
    const f = makeFake((_, c) => {
      c.n += 1;
    });
    await settleAfterClick(f.page, f.counter, 0);
    expect(f.polls()).toBe(15);
  });

  it("counts activity already present versus preCount as seen", async () => {
    const f = makeFake(() => {});
    f.counter.n = 5;
    await settleAfterClick(f.page, f.counter, 2);
    expect(f.polls()).toBe(3);
  });

  it("waits for a text-only re-render in a checkout wizard that moves no counter", async () => {
    const f = makeFake(() => {});
    const text = (): string => (f.polls() >= 8 ? "step 3" : f.polls() >= 1 ? "step 2" : "step 1");
    await settleAfterClick(f.page, f.counter, 0, async () => text());
    expect(f.polls()).toBeGreaterThan(8);
    expect(f.polls()).toBeLessThanOrEqual(15);
  });

  it("still gives up at 14 polls when text never changes", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(f.page, f.counter, 0, async () => "same");
    expect(f.polls()).toBe(14);
  });

  it("stops at the max when text changes continuously", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(f.page, f.counter, 0, async () => `t${f.polls()}`);
    expect(f.polls()).toBe(15);
  });
});
