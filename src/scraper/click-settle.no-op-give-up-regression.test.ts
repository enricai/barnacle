import { describe, expect, it } from "vitest";

import { IDLE_GIVE_UP_MS, settleAfterClick } from "@/scraper/click-settle";
import type { PhantomClickAttempt } from "@/scraper/phantom-click";
import { classifyPhantomClick } from "@/scraper/phantom-click";

const URL = "https://apply.acme.example/jobs/1/apply";
const TEXT = "Apply for this job";

function makeIdlePage(): { page: { waitForTimeout: (ms: number) => Promise<void> }; waited: () => number } {
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
