import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { IDLE_GIVE_UP_MS, settleAfterClick } from "@/scraper/click-settle";
import { settleAndSnapshotPostClick } from "@/scraper/flow-runner";
import type { PhantomClickAttempt } from "@/scraper/phantom-click";
import { classifyPhantomClick, hasSubmitStepDomAdvanced } from "@/scraper/phantom-click";

const URL = "https://apply.acme.example/jobs/1/apply";
const TEXT = "Apply for this job";

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
  it("settles once, snapshots once and returns the unsettled snapshot", async () => {
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
    expect(snapshot).toHaveBeenCalledTimes(1);
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
