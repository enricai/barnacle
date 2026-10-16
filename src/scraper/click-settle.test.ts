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
    await settleAfterClick(f.page, f.counter, 0, true);
    expect(f.polls()).toBe(9);
  });

  it("returns after activity at ~11s plus quiet polls", async () => {
    const f = makeFake((p, c) => {
      if (p === 11) c.n += 1;
    });
    await settleAfterClick(f.page, f.counter, 0, true);
    expect(f.polls()).toBe(14);
  });

  it("gives up when no activity ever appears", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(f.page, f.counter, 0, true);
    expect(f.polls()).toBe(14);
  });

  it("stops at the max on a continuous stream", async () => {
    const f = makeFake((_, c) => {
      c.n += 1;
    });
    await settleAfterClick(f.page, f.counter, 0, true);
    expect(f.polls()).toBe(60);
  });

  it("counts activity already present versus preCount as seen", async () => {
    const f = makeFake(() => {});
    f.counter.n = 5;
    await settleAfterClick(f.page, f.counter, 2, true);
    expect(f.polls()).toBe(3);
  });

  it("waits for a text-only re-render in a checkout wizard that moves no counter", async () => {
    const f = makeFake(() => {});
    const text = (): string => (f.polls() >= 8 ? "step 3" : f.polls() >= 1 ? "step 2" : "step 1");
    await settleAfterClick(f.page, f.counter, 0, true, async () => text());
    expect(f.polls()).toBe(17);
  });

  it("still gives up at 14 polls when text never changes", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(f.page, f.counter, 0, true, async () => "same");
    expect(f.polls()).toBe(14);
  });

  it("stops at the max when text changes continuously", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(f.page, f.counter, 0, true, async () => `t${f.polls()}`);
    expect(f.polls()).toBe(60);
  });

  it("counts a flip before settle start and waits for a later body re-render", async () => {
    const f = makeFake(() => {});
    const text = (): string => (f.polls() >= 9 ? "body" : "header");
    await settleAfterClick(f.page, f.counter, 0, true, async () => text(), "example.com pre");
    expect(f.polls()).toBeGreaterThan(9);
  });

  it("still gives up at 14 polls when text matches the pre-click baseline", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(f.page, f.counter, 0, true, async () => "same", "same");
    expect(f.polls()).toBe(14);
  });

  it("does not return between a header flip and a later body re-render", async () => {
    const f = makeFake(() => {});
    const text = (): string =>
      f.polls() >= 8 ? "body" : f.polls() >= 1 ? "header" : "example.com pre";
    await settleAfterClick(f.page, f.counter, 0, true, async () => text(), "example.com pre");
    expect(f.polls()).toBe(17);
  });

  it("treats a change that landed before the first poll as activity versus the pre-click baseline", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => "example.com after",
      "example.com pre"
    );
    expect(f.polls()).toBe(10);
  });

  it("returns only after a body re-render ~8s after a header flip plus the quiet window", async () => {
    const f = makeFake(() => {});
    const text = (): string =>
      f.polls() >= 9 ? "body" : f.polls() >= 1 ? "header" : "example.com pre";
    await settleAfterClick(f.page, f.counter, 0, true, async () => text(), "example.com pre");
    expect(f.polls()).toBe(18);
  });

  it("awaits a re-render landing past the old 15s total while activity continues", async () => {
    const f = makeFake(() => {});
    const text = (): string => (f.polls() >= 20 ? "body" : `header ${f.polls()}`);
    await settleAfterClick(f.page, f.counter, 0, true, async () => text(), "example.com pre");
    expect(f.polls()).toBe(29);
  });

  it("gives up after one poll for a non-submit click with no activity", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(f.page, f.counter, 0, false);
    expect(f.polls()).toBe(1);
  });

  it("still waits the full idle window for a submit-shaped click", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(f.page, f.counter, 0, true);
    expect(f.polls()).toBe(14);
  });

  it("keeps activity-driven quiet logic for a non-submit click", async () => {
    const f = makeFake((p, c) => {
      if (p === 1) c.n += 1;
    });
    await settleAfterClick(f.page, f.counter, 0, false);
    expect(f.polls()).toBe(4);
  });

  it("waits for pending requests the capture never counts after an early header flip", async () => {
    const f = makeFake(() => {});
    const text = (): string => (f.polls() >= 12 ? "body" : f.polls() >= 1 ? "header" : "pre");
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => text(),
      "pre",
      async () => ({ pending: f.polls() < 12 ? 1 : 0, mutations: f.polls() >= 12 ? 1 : 0 })
    );
    expect(f.polls()).toBe(22);
  });

  it("still gives up at 14 polls on a no-op click when the page reports idle", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => "same",
      "same",
      async () => ({
        pending: 0,
        mutations: 0,
      })
    );
    expect(f.polls()).toBe(14);
  });

  it("stops at the max when the page never goes idle", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(f.page, f.counter, 0, true, undefined, undefined, async () => ({
      pending: 1,
      mutations: 0,
    }));
    expect(f.polls()).toBe(60);
  });

  it("gives up at 14 polls when the text never moved", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => "same",
      "same"
    );
    expect(f.polls()).toBe(14);
  });

  it("ends only after a body re-render following a header flip when the probe sees mutations", async () => {
    const f = makeFake(() => {});
    const text = (): string =>
      f.polls() >= 10 ? "body" : f.polls() >= 1 ? "header" : "pre";
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => text(),
      "pre",
      async () => ({ pending: 0, mutations: f.polls() >= 10 ? 1 : 0 })
    );
    expect(f.polls()).toBeGreaterThanOrEqual(19);
  });
});
