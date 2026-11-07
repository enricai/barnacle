import type { Page } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { stepJudge, submitJudge } = vi.hoisted(() => ({
  stepJudge: vi.fn(),
  submitJudge: vi.fn(),
}));

vi.mock("@/lib/llm/judges/verify-step-advanced", () => ({
  verifyStepAdvancedWithLLM: stepJudge,
}));
vi.mock("@/lib/llm/judges/verify-submit", async (orig) => ({
  ...(await orig<object>()),
  verifySubmitWithLLM: submitJudge,
}));

import {
  IDLE_GIVE_UP_MS,
  MAX_MS,
  QUIESCENT_NO_OP_GIVE_UP_MS,
  settleAfterClick,
} from "@/scraper/click-settle";
import {
  judgeStepOutcome,
  type PostClickSettleIo,
  readMidFlowPostClickAdvance,
} from "@/scraper/flow-runner";
import { classifyPhantomClick, hasSettledPageAdvanced } from "@/scraper/phantom-click";

const URL = "https://shop.example/checkout";
const PRE_TEXT = "Skip to main content|Sign In|Careers Home|";
const HEADER_FLIPPED = "Skip to main content|Settings|Careers Home|";
const POST_TEXT = "Skip to main content|Settings|Order summary|Careers Home|";
const RERENDER_DELAY_MS = 8000;

type Snap = Parameters<typeof readMidFlowPostClickAdvance>[0]["pre"];

const idleQuiescence = async (): Promise<{ pending: number; mutations: number }> => ({
  pending: 0,
  mutations: 0,
});

function drivePage(visibleAt: (waited: number) => string): {
  io: PostClickSettleIo;
  waited: () => number;
} {
  let waited = 0;
  const page = {
    waitForTimeout: async (ms: number): Promise<void> => {
      waited += ms;
    },
  };
  const read = async (): Promise<string> => `${visibleAt(waited).length}:${visibleAt(waited)}`;
  const snapshot = async (): Promise<Snap> =>
    ({
      networkCount: 0,
      url: URL,
      bodyHtmlLength: visibleAt(waited).length,
      visibleTextSignature: `${visibleAt(waited).length}:${visibleAt(waited)}`,
      formValueSignature: "",
    }) as Snap;
  const io = {
    settle: async (...args: unknown[]) => {
      const baseline = args[5] as string;
      const hold = args[7] as number | undefined;
      return settleAfterClick(page, { n: 0 }, 0, true, read, baseline, idleQuiescence, hold);
    },
    snapshot,
  } as unknown as PostClickSettleIo;
  return { io, waited: () => waited };
}

async function readAdvance(
  io: PostClickSettleIo
): Promise<Awaited<ReturnType<typeof readMidFlowPostClickAdvance>>> {
  const pre = await io.snapshot({} as never, { n: 0 }, {} as Page);
  return readMidFlowPostClickAdvance({
    target: {} as never,
    signalCounter: { n: 0 },
    page: {} as Page,
    pre,
    stepStartSnapshot: pre,
    midFlowSubmit: true,
    io,
  });
}

describe("report contract: non-final submit-shaped click, header flips at once, body late", () => {
  it("is credited as advanced once visible text settles on the new view, with no counted network", async () => {
    const f = drivePage((w) =>
      w >= RERENDER_DELAY_MS ? POST_TEXT : w >= 1000 ? HEADER_FLIPPED : PRE_TEXT
    );
    const pre = await f.io.snapshot({} as never, { n: 0 }, {} as Page);
    const r = await readAdvance(f.io);
    expect(f.waited()).toBeGreaterThanOrEqual(RERENDER_DELAY_MS);
    expect(r.pageAdvanced).toBe(true);
    expect(r.post.networkCount).toBe(0);
    expect(hasSettledPageAdvanced(pre, r.post)).toBe(true);
    expect(
      classifyPhantomClick({
        actResultSuccess: true,
        pre,
        post: r.post,
        destinationPlausible: true,
        isSubmitShapedStep: true,
        isMidFlowSubmitStep: true,
      })
    ).toBe("effective");
  });

  it.each([20_000, 60_000])(
    "is credited when the body re-renders %ims after the header flipped, with a quiet page in between",
    async (delay) => {
      const f = drivePage((w) =>
        w >= 1000 + delay ? POST_TEXT : w >= 1000 ? HEADER_FLIPPED : PRE_TEXT
      );
      const r = await readAdvance(f.io);
      expect(r.pageAdvanced).toBe(true);
      expect(r.post.visibleTextSignature).toContain("Order summary");
      expect(r.post.networkCount).toBe(0);
    }
  );

  it("is credited when the body re-renders in two stages with a quiet gap between them", async () => {
    const LOADING = "Skip to main content|Settings|Loading|Careers Home|";
    const f = drivePage((w) =>
      w >= 80_000 ? POST_TEXT : w >= 30_000 ? LOADING : w >= 1000 ? HEADER_FLIPPED : PRE_TEXT
    );
    const r = await readAdvance(f.io);
    expect(r.pageAdvanced).toBe(true);
  });

  it("credits a header flip that never re-renders the body within one bounded re-settle round", async () => {
    const flipped = "Skip to main content|Settings|user@example.test|Careers Home|Candidate Home|";
    const f = drivePage((w) => (w >= 1000 ? flipped : PRE_TEXT));
    const r = await readAdvance(f.io);
    expect(r.pageAdvanced).toBe(true);
    expect(f.waited()).toBeLessThanOrEqual(IDLE_GIVE_UP_MS + MAX_MS);
  });

  it.each([
    ["same-length body swap", 9000, "Skip to main content|Settings|Careers Home|Candidate Home"],
    ["slightly shorter body", 12000, "Skip to main content|Settings|Careers Home|Candidate"],
  ])(
    "credits promptly once the page settles after a %s lands after the header flip",
    async (_name, delay, body) => {
      const flip = "Skip to main content|Settings|Careers Home|Applications!!";
      const f = drivePage((w) => (w >= 1000 + delay ? body : w >= 1000 ? flip : PRE_TEXT));
      const r = await readAdvance(f.io);
      expect(r.pageAdvanced).toBe(true);
      expect(r.post.visibleTextSignature).toContain(body);
      expect(f.waited()).toBeLessThan(IDLE_GIVE_UP_MS + delay + 10_000);
    }
  );

  it("credits promptly when the header flips with a text shrink and the body lands later", async () => {
    const wide = `996:${"Sign In|Careers Home|Back to Job Posting|".repeat(2)}Apply`;
    const flip = "588:Skip to main content|Settings|Careers Home|Candidate Home|Apply";
    const body = "588:Skip to main content|Settings|Careers Home|Candidate Home|My Applications";
    const f = drivePage((w) => (w >= 9000 ? body : w >= 1000 ? flip : wide));
    const r = await readAdvance(f.io);
    expect(r.pageAdvanced).toBe(true);
    expect(f.waited()).toBeLessThan(IDLE_GIVE_UP_MS + 9000 + 10_000);
  });

  it("keeps a genuine no-op at the QUIESCENT_NO_OP_GIVE_UP_MS give-up and phantom", async () => {
    const f = drivePage(() => PRE_TEXT);
    const pre = await f.io.snapshot({} as never, { n: 0 }, {} as Page);
    const r = await readAdvance(f.io);
    expect(f.waited()).toBe(QUIESCENT_NO_OP_GIVE_UP_MS);
    expect(r.pageAdvanced).toBe(false);
    expect(
      classifyPhantomClick({
        actResultSuccess: true,
        pre,
        post: r.post,
        destinationPlausible: true,
        isSubmitShapedStep: true,
      })
    ).toBe("phantom");
  });
});

describe("report contract: stale title contradicting visible text", () => {
  const STEP =
    "On the account registration form, click the 'Create Account' button to submit the account creation form";
  const SUBMIT_INPUT = {
    pageUrl: URL,
    pageTitle: "Sign In",
    unfocusedObserve: [],
    networkCaptures: [],
    invalidMarkerCount: 0,
    ownBackendHostnames: [],
    successUrlFragments: [],
    successPageTitleHints: [],
    submittedStateSelectors: [],
  };

  function run(isFinalStep: boolean): ReturnType<typeof judgeStepOutcome> {
    const evaluate = async (expr: string): Promise<unknown> => {
      if (expr.includes("__settleQ")) return { pending: 0, mutations: 0 };
      if (expr.includes("outerHTML"))
        return {
          html: POST_TEXT.length,
          text: `${POST_TEXT.length}:${POST_TEXT}`,
          values: "",
          state: "",
        };
      return POST_TEXT;
    };
    return judgeStepOutcome({
      client: {} as never,
      step: STEP,
      isFinalStep,
      submitStep: true,
      flowHasSubmitSemantics: true,
      page: { waitForTimeout: async () => {} },
      target: { url: async () => URL, evaluate } as never,
      signalCounter: { n: 0 },
      preNetworkCount: 0,
      preVisibleTextSignature: `${PRE_TEXT.length}:${PRE_TEXT}`,
      settledPostVisibleText: POST_TEXT,
      preVisibleText: PRE_TEXT,
      submitInput: SUBMIT_INPUT,
    });
  }

  beforeEach(() => {
    stepJudge.mockReset();
    submitJudge.mockReset();
  });

  it("verifies a non-final step from visible text without the title-based submit judge", async () => {
    stepJudge.mockResolvedValue({ advanced: true, reason: "order summary shown" });
    const v = await run(false);
    expect(submitJudge).not.toHaveBeenCalled();
    expect(v).toMatchObject({ verified: true });
  });

  it("keeps the final step on the strict submit judge", async () => {
    submitJudge.mockResolvedValue({
      verified: false,
      reason: "the page title remains 'Sign In' rather than showing a success confirmation",
    });
    const v = await run(true);
    expect(stepJudge).not.toHaveBeenCalled();
    expect(v).toMatchObject({ verified: false });
  });
});
