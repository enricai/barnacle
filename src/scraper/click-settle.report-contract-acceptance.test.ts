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

import { QUIESCENT_NO_OP_GIVE_UP_MS, settleAfterClick } from "@/scraper/click-settle";
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
    settle: async (): Promise<void> => {
      const pre = await snapshot();
      await settleAfterClick(
        page,
        { n: 0 },
        0,
        true,
        read,
        pre.visibleTextSignature,
        idleQuiescence
      );
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
