import { describe, expect, it } from "vitest";
import { QUIESCENT_NO_OP_GIVE_UP_MS, settleAfterClick } from "@/scraper/click-settle";

const idleQuiescence = async (): Promise<{
  pending: number;
  mutations: number;
}> => ({
  pending: 0,
  mutations: 0,
});

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
    await settleAfterClick(f.page, f.counter, 0, true, undefined, undefined, async () => ({
      pending: f.polls() < 6 ? 1 : 0,
      mutations: 0,
    }));
    expect(f.polls()).toBe(15);
  });

  it("returns after activity at ~11s plus quiet polls", async () => {
    const f = makeFake((p, c) => {
      if (p === 11) c.n += 1;
    });
    await settleAfterClick(f.page, f.counter, 0, true, undefined, undefined, async () => ({
      pending: f.polls() < 11 ? 1 : 0,
      mutations: 0,
    }));
    expect(f.polls()).toBe(20);
  });

  it("gives up when no activity ever appears", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(f.page, f.counter, 0, true, undefined, undefined, idleQuiescence);
    expect(f.polls()).toBe(QUIESCENT_NO_OP_GIVE_UP_MS / 1000);
  });

  it("stops at the max on a continuous stream", async () => {
    const f = makeFake((_, c) => {
      c.n += 1;
    });
    await settleAfterClick(f.page, f.counter, 0, true, undefined, undefined, idleQuiescence);
    expect(f.polls()).toBe(60);
  });

  it("counts activity already present versus preCount as seen", async () => {
    const f = makeFake(() => {});
    f.counter.n = 5;
    await settleAfterClick(f.page, f.counter, 2, true, undefined, undefined, idleQuiescence);
    expect(f.polls()).toBe(14);
  });

  it("keeps the short quiet exit for a non-submit click that saw network", async () => {
    const f = makeFake(() => {});
    f.counter.n = 5;
    await settleAfterClick(f.page, f.counter, 2, false, undefined, undefined, idleQuiescence);
    expect(f.polls()).toBe(3);
  });

  it("does not return a network-seen submit-shaped click before a late re-render", async () => {
    const f = makeFake((p, c) => {
      if (p === 1) c.n += 1;
    });
    const text = (): string => (f.polls() >= 10 ? "step 2" : "step 1");
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => text(),
      "step 1",
      idleQuiescence
    );
    expect(f.polls()).toBeGreaterThanOrEqual(19);
  });

  it("waits for a text-only re-render in a checkout wizard that moves no counter", async () => {
    const f = makeFake(() => {});
    const text = (): string => (f.polls() >= 8 ? "step 3" : f.polls() >= 1 ? "step 2" : "step 1");
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => text(),
      undefined,
      idleQuiescence
    );
    expect(f.polls()).toBe(17);
  });

  it("still gives up at the quiescent no-op bound when text never changes", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => "same",
      undefined,
      idleQuiescence
    );
    expect(f.polls()).toBe(QUIESCENT_NO_OP_GIVE_UP_MS / 1000);
  });

  it("stops at the max when text changes continuously", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => `t${f.polls()}`,
      undefined,
      idleQuiescence
    );
    expect(f.polls()).toBe(60);
  });

  it("counts a flip before settle start and waits for a later body re-render", async () => {
    const f = makeFake(() => {});
    const text = (): string => (f.polls() >= 9 ? "body" : "header");
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => text(),
      "example.com pre",
      idleQuiescence
    );
    expect(f.polls()).toBeGreaterThan(9);
  });

  it("still gives up at the quiescent no-op bound when text matches the pre-click baseline", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(f.page, f.counter, 0, true, async () => "same", "same", idleQuiescence);
    expect(f.polls()).toBe(QUIESCENT_NO_OP_GIVE_UP_MS / 1000);
  });

  it("does not return between a header flip and a later body re-render", async () => {
    const f = makeFake(() => {});
    const text = (): string =>
      f.polls() >= 8 ? "body" : f.polls() >= 1 ? "header" : "example.com pre";
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => text(),
      "example.com pre",
      idleQuiescence
    );
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
      "example.com pre",
      idleQuiescence
    );
    expect(f.polls()).toBe(14);
  });

  it("returns only after a body re-render ~8s after a header flip plus the quiet window", async () => {
    const f = makeFake(() => {});
    const text = (): string =>
      f.polls() >= 9 ? "body" : f.polls() >= 1 ? "header" : "example.com pre";
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => text(),
      "example.com pre",
      idleQuiescence
    );
    expect(f.polls()).toBe(18);
  });

  it("awaits a re-render landing past the old 15s total while activity continues", async () => {
    const f = makeFake(() => {});
    const text = (): string => (f.polls() >= 20 ? "body" : `header ${f.polls()}`);
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => text(),
      "example.com pre",
      idleQuiescence
    );
    expect(f.polls()).toBe(29);
  });

  it("gives up after one poll for a non-submit click with no activity", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(f.page, f.counter, 0, false, undefined, undefined, idleQuiescence);
    expect(f.polls()).toBe(1);
  });

  it("still waits the full idle window for a submit-shaped click", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(f.page, f.counter, 0, true, undefined, undefined, idleQuiescence);
    expect(f.polls()).toBe(QUIESCENT_NO_OP_GIVE_UP_MS / 1000);
  });

  it("keeps activity-driven quiet logic for a non-submit click", async () => {
    const f = makeFake((p, c) => {
      if (p === 1) c.n += 1;
    });
    await settleAfterClick(f.page, f.counter, 0, false, undefined, undefined, idleQuiescence);
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
      async () => ({
        pending: f.polls() < 12 ? 1 : 0,
        mutations: f.polls() >= 12 ? 1 : 0,
      })
    );
    expect(f.polls()).toBe(22);
  });

  it("gives up at 4 polls on a no-op submit-shaped click when the page reports idle", async () => {
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
    expect(f.polls()).toBe(4);
  });

  it("stops at the max when the page never goes idle", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(f.page, f.counter, 0, true, undefined, undefined, async () => ({
      pending: 1,
      mutations: 0,
    }));
    expect(f.polls()).toBe(60);
  });

  it("gives up at the quiescent no-op bound when the text never moved", async () => {
    const f = makeFake(() => {});
    await settleAfterClick(f.page, f.counter, 0, true, async () => "same", "same", idleQuiescence);
    expect(f.polls()).toBe(QUIESCENT_NO_OP_GIVE_UP_MS / 1000);
  });

  it("ends only after a body re-render following a header flip when the probe sees mutations", async () => {
    const f = makeFake(() => {});
    const text = (): string => (f.polls() >= 10 ? "body" : f.polls() >= 1 ? "header" : "pre");
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

  it("returns only after a body re-render ~10s after a header flip with no counted network", async () => {
    const f = makeFake(() => {});
    const text = (): string =>
      f.polls() >= 10 ? "body" : f.polls() >= 1 ? "header" : "example.com pre";
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => text(),
      "example.com pre",
      idleQuiescence
    );
    expect(f.polls()).toBeGreaterThanOrEqual(19);
    expect(f.polls()).toBeLessThan(60);
  });

  it("waits while the body keeps growing after a header flip, then ends once it stops", async () => {
    const f = makeFake(() => {});
    const text = (): string =>
      f.polls() === 0 ? "example.com pre" : `header${"x".repeat(Math.min(f.polls(), 12))}`;
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => text(),
      "example.com pre",
      idleQuiescence
    );
    expect(f.polls()).toBeGreaterThan(12);
    expect(f.polls()).toBeLessThan(60);
  });

  it("waits for a body re-render at 11s after a header flip at poll 1 with no network", async () => {
    const f = makeFake(() => {});
    const text = (): string =>
      f.polls() >= 11 ? "body" : f.polls() >= 1 ? "header" : "example.com pre";
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => text(),
      "example.com pre",
      idleQuiescence
    );
    expect(f.polls()).toBe(20);
  });

  it("holds a non-submit click whose text moved to the idle allowance before giving up", async () => {
    const f = makeFake(() => {});
    const text = (): string => (f.polls() >= 1 ? "header" : "example.com pre");
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      false,
      async () => text(),
      "example.com pre",
      idleQuiescence
    );
    expect(f.polls()).toBe(14);
  });

  it.each([true, false])(
    "snapshots after a body re-render 13s after a header flip (submitShaped=%s)",
    async (submitShaped) => {
      const f = makeFake(() => {});
      const text = (): string =>
        f.polls() >= 13 ? "body" : f.polls() >= 1 ? "header" : "example.com pre";
      await settleAfterClick(
        f.page,
        f.counter,
        0,
        submitShaped,
        async () => text(),
        "example.com pre",
        idleQuiescence
      );
      expect(f.polls()).toBeGreaterThanOrEqual(22);
    }
  );

  it("waits for a body re-render at 3s after a header flip at poll 1 with no network", async () => {
    const f = makeFake(() => {});
    const text = (): string =>
      f.polls() >= 3 ? "body" : f.polls() >= 1 ? "header" : "example.com pre";
    await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => text(),
      "example.com pre",
      idleQuiescence
    );
    expect(f.polls()).toBe(14);
  });

  for (const at of [5, 8, 12]) {
    it(`credits a body re-render at ${at}s after a header flip without a probe`, async () => {
      const f = makeFake(() => {});
      const text = (): string =>
        f.polls() >= at ? "body" : f.polls() >= 1 ? "header" : "example.com pre";
      await settleAfterClick(
        f.page,
        f.counter,
        0,
        true,
        async () => text(),
        "example.com pre",
        idleQuiescence
      );
      expect(f.polls()).toBe(at + 9);
    });

    it(`credits a body re-render at ${at}s after a header flip with a quiescence probe`, async () => {
      const f = makeFake(() => {});
      const text = (): string =>
        f.polls() >= at ? "body" : f.polls() >= 1 ? "header" : "example.com pre";
      await settleAfterClick(
        f.page,
        f.counter,
        0,
        true,
        async () => text(),
        "example.com pre",
        async () => ({ pending: 0, mutations: f.polls() >= at ? 1 : 0 })
      );
      expect(f.polls()).toBeGreaterThanOrEqual(at + 9);
      expect(f.polls()).toBeLessThan(60);
    });
  }

  it("reads a body that lands after a long quiet gap once the page reports its pending render", async () => {
    const f = makeFake(() => {});
    const text = (): string =>
      f.polls() >= 30 ? "body" : f.polls() >= 1 ? "header" : "example.com pre";
    const q = async (): Promise<{ pending: number; mutations: number }> => ({
      pending: f.polls() >= 5 && f.polls() < 30 ? 1 : 0,
      mutations: 0,
    });
    await settleAfterClick(f.page, f.counter, 0, true, async () => text(), "example.com pre", q);
    expect(f.polls()).toBeGreaterThanOrEqual(30);
    expect(f.polls()).toBeLessThan(60);
  });

  describe("holdUnmovedMs", () => {
    const HOLD_MS = 60_000;
    const q = async (): Promise<{ pending: number; mutations: number }> => ({
      pending: 0,
      mutations: 0,
    });

    it("keeps waiting through a long quiet gap after the header flip until the body lands", async () => {
      const f = makeFake(() => {});
      const text = (): string => (f.polls() >= 40 ? "body" : "header");
      await settleAfterClick(f.page, f.counter, 0, true, async () => text(), "pre", q, HOLD_MS);
      expect(f.polls()).toBeGreaterThanOrEqual(40);
    });

    it("does not spend the rest of the allowance once the text moves again", async () => {
      const f = makeFake(() => {});
      const text = (): string => (f.polls() >= 20 ? "body" : "header");
      await settleAfterClick(f.page, f.counter, 0, true, async () => text(), "pre", q, HOLD_MS);
      expect(f.polls()).toBeLessThan(HOLD_MS / 1000);
    });

    it("ends the hold on probe quiescence once the probe saw the page re-render", async () => {
      const f = makeFake(() => {});
      const busy = async (): Promise<{ pending: number; mutations: number }> => ({
        pending: f.polls() >= 3 && f.polls() < 8 ? 1 : 0,
        mutations: 0,
      });
      const outcome = await settleAfterClick(
        f.page,
        f.counter,
        0,
        true,
        async () => "header",
        "pre",
        busy,
        HOLD_MS
      );
      expect(outcome).toBe("quiescent");
      expect(f.polls()).toBeLessThan(HOLD_MS / 1000);
    });

    it("holds a header flip whose body never re-renders to the allowance", async () => {
      const f = makeFake(() => {});
      await settleAfterClick(f.page, f.counter, 0, true, async () => "header", "pre", q, HOLD_MS);
      expect(f.polls()).toBe(HOLD_MS / 1000);
    });

    it("leaves a silent click on the quiescent no-op give-up", async () => {
      const f = makeFake(() => {});
      await settleAfterClick(f.page, f.counter, 0, true, async () => "pre", "pre", q, HOLD_MS);
      expect(f.polls()).toBe(QUIESCENT_NO_OP_GIVE_UP_MS / 1000);
    });
  });
});

describe("settleAfterClick outcome", () => {
  it("reports quiescent when the probe is idle and text is stable", async () => {
    const f = makeFake(() => {});
    const r = await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => "a",
      "b",
      idleQuiescence
    );
    expect(r).toBe("quiescent");
  });

  it("reports quiescent for the silent no-op give-up", async () => {
    const f = makeFake(() => {});
    const r = await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => "a",
      "a",
      idleQuiescence
    );
    expect(r).toBe("quiescent");
  });

  it("reports rerendered when the text changed again after its first change and went quiet", async () => {
    const f = makeFake(() => {});
    const r = await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => (f.polls() >= 9 ? "body" : f.polls() >= 1 ? "header" : "pre"),
      "pre",
      idleQuiescence
    );
    expect(r).toBe("rerendered");
    expect(f.polls()).toBeLessThan(30);
  });

  it("reports rerendered when the call starts on the first change and a later render lands", async () => {
    const f = makeFake(() => {});
    const r = await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => (f.polls() >= 8 ? "body" : "header"),
      "pre",
      idleQuiescence
    );
    expect(r).toBe("rerendered");
  });

  it("reports plain quiescent for a single text change that never re-renders", async () => {
    const f = makeFake(() => {});
    const r = await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => (f.polls() >= 1 ? "header" : "pre"),
      "pre",
      idleQuiescence
    );
    expect(r).toBe("quiescent");
  });

  it("reports ceiling when a busy probe keeps the page moving to MAX_MS", async () => {
    const f = makeFake(() => {});
    const r = await settleAfterClick(
      f.page,
      f.counter,
      0,
      true,
      async () => "a",
      "a",
      async () => ({
        pending: 1,
        mutations: 0,
      })
    );
    expect(r).toBe("ceiling");
    expect(f.polls()).toBe(60);
  });
});
