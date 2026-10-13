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
});
