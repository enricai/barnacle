import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { IDLE_GIVE_UP_MS, settleAfterClick } from "@/scraper/click-settle";
import {
  type PostClickSettleIo,
  readMidFlowPostClickAdvance,
  settleAndSnapshotPostClick,
} from "@/scraper/flow-runner";
import type { PhantomClickAttempt } from "@/scraper/phantom-click";
import { classifyPhantomClick, hasSubmitStepDomAdvanced } from "@/scraper/phantom-click";

const URL = "https://apply.acme.example/jobs/1/apply";
const TEXT = "Apply for this job";
const NOOP_SIGNATURE = "996:Skip to main content|Sign In|Careers Home|";
const ADVANCED_SIGNATURE = "588:Skip to main content|Settings|<email>|Careers Home|Candidate Home|";

function makeIdlePage(): {
  page: { waitForTimeout: (ms: number) => Promise<void> };
  waited: () => number;
} {
  let waited = 0;
  return {
    page: {
      waitForTimeout: async (ms: number): Promise<void> => {
        waited += ms;
      },
    },
    waited: () => waited,
  };
}

const idleQuiescence = async (): Promise<{ pending: number; mutations: number }> => ({
  pending: 0,
  mutations: 0,
});

describe("settleAfterClick: a genuine no-op click gives up at the unchanged bound", () => {
  it("gives up after one quiet poll for a non-submit-shaped click", async () => {
    const f = makeIdlePage();
    await settleAfterClick(f.page, { n: 0 }, 0, false, async () => TEXT, TEXT, idleQuiescence);
    expect(f.waited()).toBe(1000);
  });

  it("gives up at IDLE_GIVE_UP_MS for a submit-shaped click", async () => {
    const f = makeIdlePage();
    await settleAfterClick(f.page, { n: 0 }, 0, true, async () => TEXT, TEXT, idleQuiescence);
    expect(f.waited()).toBe(IDLE_GIVE_UP_MS);
  });

  it("classifies a click that changes no text, network or URL as phantom", () => {
    const attempt: PhantomClickAttempt = {
      actResultSuccess: true,
      pre: { networkCount: 0, url: URL, bodyHtmlLength: 5000 },
      post: { networkCount: 0, url: URL, bodyHtmlLength: 5000 },
      destinationPlausible: true,
    };
    expect(classifyPhantomClick(attempt)).toBe("phantom");
  });
});

type PostClickArgs = Parameters<typeof settleAndSnapshotPostClick>;

describe("settleAndSnapshotPostClick: a no-op click is not re-settled", () => {
  it("settles once, re-reads once without settling and returns the unsettled snapshot", async () => {
    const pre = {
      networkCount: 0,
      url: URL,
      bodyHtmlLength: 5000,
      visibleTextSignature: TEXT,
      formValueSignature: "",
    } as PostClickArgs[3];
    const settle = vi.fn(async () => undefined);
    const snapshot = vi.fn(async () => ({ ...pre }));
    const result = await settleAndSnapshotPostClick(
      {} as PostClickArgs[0],
      { n: 0 },
      {} as Page,
      pre,
      true,
      { settle, snapshot } as unknown as PostClickArgs[5]
    );
    expect(settle).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(result.settled).toBeUndefined();
  });
});

describe("a final submit is not credited on DOM text alone", () => {
  const pre = { visibleTextSignature: "10:Review and submit your application" };
  const post = { visibleTextSignature: "4:Done", settled: true };

  it("hasSubmitStepDomAdvanced never credits the final step", () => {
    expect(hasSubmitStepDomAdvanced(true, pre, post)).toBe(false);
  });

  it("classifyPhantomClick keeps a submit-shaped DOM-only change phantom", () => {
    const attempt: PhantomClickAttempt = {
      actResultSuccess: true,
      pre: { networkCount: 0, url: URL, bodyHtmlLength: 5000, ...pre },
      post: { networkCount: 0, url: URL, bodyHtmlLength: 9000, ...post },
      destinationPlausible: true,
      isSubmitShapedStep: true,
    };
    expect(classifyPhantomClick(attempt)).toBe("phantom");
  });
});

describe("settleAfterClick: an unchanged signature gives up at the unchanged bound", () => {
  it("does not wait past IDLE_GIVE_UP_MS when the signature never moves from the pre value", async () => {
    const f = makeIdlePage();
    await settleAfterClick(
      f.page,
      { n: 0 },
      0,
      true,
      async () => NOOP_SIGNATURE,
      NOOP_SIGNATURE,
      idleQuiescence
    );
    expect(f.waited()).toBeLessThanOrEqual(IDLE_GIVE_UP_MS);
    expect(ADVANCED_SIGNATURE).not.toBe(NOOP_SIGNATURE);
  });
});

describe("settleAfterClick: elapsed give-up time is pinned numerically", () => {
  it("returns after the activity poll plus the quiet window for a non-submit click with one late request", async () => {
    const counter = { n: 0 };
    let waited = 0;
    const page = {
      waitForTimeout: async (ms: number): Promise<void> => {
        waited += ms;
        if (waited === 1000) counter.n = 1;
      },
    };
    await settleAfterClick(page, counter, 0, false, async () => TEXT, TEXT, idleQuiescence);
    expect(waited).toBe(4000);
  });

  it("does not extend a silent submit-shaped click beyond IDLE_GIVE_UP_MS", async () => {
    const f = makeIdlePage();
    await settleAfterClick(f.page, { n: 0 }, 0, true, async () => TEXT, TEXT, idleQuiescence);
    expect(f.waited()).toBe(IDLE_GIVE_UP_MS);
  });
});

describe("readMidFlowPostClickAdvance: a no-op submit click is phantom within the give-up bound", () => {
  it("elapses no more than IDLE_GIVE_UP_MS on the fake clock and classifies phantom", async () => {
    const snap = {
      networkCount: 0,
      url: URL,
      bodyHtmlLength: 5000,
      visibleTextSignature: TEXT,
      formValueSignature: "",
    } as PostClickArgs[3];
    const f = makeIdlePage();
    const io = {
      settle: async (): Promise<void> => {
        await settleAfterClick(f.page, { n: 0 }, 0, true, async () => TEXT, TEXT, idleQuiescence);
      },
      snapshot: async () => ({ ...snap }),
    } as unknown as PostClickSettleIo;
    const r = await readMidFlowPostClickAdvance({
      target: {} as never,
      signalCounter: { n: 0 },
      page: {} as Page,
      pre: snap,
      stepStartSnapshot: snap,
      midFlowSubmit: true,
      io,
    });
    expect(f.waited()).toBeLessThanOrEqual(IDLE_GIVE_UP_MS);
    expect(r.pageAdvanced).toBe(false);
    const attempt: PhantomClickAttempt = {
      actResultSuccess: true,
      pre: snap,
      post: r.post,
      destinationPlausible: true,
      isSubmitShapedStep: true,
    };
    expect(classifyPhantomClick(attempt)).toBe("phantom");
  });
});

describe("settleAfterClick: bounded give-up is counted in polls", () => {
  it.each([
    { submitShaped: false, polls: 1 },
    { submitShaped: true, polls: IDLE_GIVE_UP_MS / 1000 },
  ])(
    "polls $polls times on a silent page when submitShaped=$submitShaped",
    async ({ submitShaped, polls }) => {
      const waitForTimeout = vi.fn(async (): Promise<void> => undefined);
      await settleAfterClick(
        { waitForTimeout },
        { n: 0 },
        0,
        submitShaped,
        async () => TEXT,
        TEXT,
        idleQuiescence
      );
      expect(waitForTimeout).toHaveBeenCalledTimes(polls);
    }
  );

  it("gives the same bound without a text or quiescence reader", async () => {
    const quick = makeIdlePage();
    await settleAfterClick(quick.page, { n: 0 }, 0, false);
    expect(quick.waited()).toBe(1000);
    const slow = makeIdlePage();
    await settleAfterClick(slow.page, { n: 0 }, 0, true);
    expect(slow.waited()).toBe(IDLE_GIVE_UP_MS);
  });

  it("still waits past the silent bound when text moves late on a submit-shaped click", async () => {
    let waited = 0;
    const page = {
      waitForTimeout: async (ms: number): Promise<void> => {
        waited += ms;
      },
    };
    const readText = async (): Promise<string> => (waited >= 8000 ? "Next view" : TEXT);
    await settleAfterClick(page, { n: 0 }, 0, true, readText, TEXT, idleQuiescence);
    expect(waited).toBeGreaterThan(IDLE_GIVE_UP_MS);
    expect(waited).toBe(17000);
  });
});
