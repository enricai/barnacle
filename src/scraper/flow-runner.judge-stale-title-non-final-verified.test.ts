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

import { judgeStepOutcome } from "@/scraper/flow-runner";

const STEP = "click the Continue button to submit this step";
const BEFORE_TEXT = "Sign In My Information";
const AFTER_TEXT = "My Experience Add your previous employers";

const SUBMIT_INPUT = {
  pageUrl: "https://example.org/apply",
  pageTitle: "Sign In",
  unfocusedObserve: [],
  networkCaptures: [],
  invalidMarkerCount: 0,
  ownBackendHostnames: [],
  successUrlFragments: [],
  successPageTitleHints: [],
  submittedStateSelectors: [],
};

function judgeTarget(read: () => string): {
  url: () => Promise<string>;
  evaluate: (expr: string) => Promise<unknown>;
} {
  return {
    url: async () => "https://example.org/apply",
    evaluate: async (expr: string) => {
      if (expr.includes("__settleQ")) return { pending: 0, mutations: 0 };
      const t = read();
      if (expr.includes("outerHTML"))
        return { html: t.length, text: `${t.length}:${t.slice(0, 200)}`, values: "", state: "" };
      return t;
    },
  };
}

function run(
  isFinalStep: boolean,
  read: () => string,
  waits: number[] = []
): ReturnType<typeof judgeStepOutcome> {
  return judgeStepOutcome({
    client: {} as never,
    step: STEP,
    isFinalStep,
    submitStep: true,
    flowHasSubmitSemantics: true,
    page: {
      waitForTimeout: async (ms: number) => {
        waits.push(ms);
      },
    },
    target: judgeTarget(read) as never,
    signalCounter: { n: 0 },
    preNetworkCount: 0,
    preVisibleTextSignature: `${BEFORE_TEXT.length}:${BEFORE_TEXT}`,
    preVisibleText: BEFORE_TEXT,
    submitInput: SUBMIT_INPUT,
  });
}

describe("judgeStepOutcome stale title", () => {
  beforeEach(() => {
    stepJudge.mockReset();
    submitJudge.mockReset();
  });

  it("verifies a non-final step whose title is stale, judging step instruction and live text", async () => {
    stepJudge.mockResolvedValue({ advanced: true, reason: "next step shown" });
    const v = await run(false, () => AFTER_TEXT);
    expect(submitJudge).not.toHaveBeenCalled();
    const input = stepJudge.mock.calls[0]?.[0].input;
    expect(input.stepInstruction).toBe(STEP);
    expect(input.beforeText).toBe(BEFORE_TEXT);
    expect(input.afterText).toBe(AFTER_TEXT);
    expect(Object.keys(input)).not.toContain("pageTitle");
    expect(v).toMatchObject({ verified: true });
  });

  it("judges a late re-render after STEP_REJUDGE_DELAY_MS on the settled read", async () => {
    stepJudge
      .mockResolvedValueOnce({ advanced: false, reason: "no change yet" })
      .mockResolvedValueOnce({ advanced: true, reason: "late render" });
    const waits: number[] = [];
    const v = await run(
      false,
      () => (stepJudge.mock.calls.length === 0 ? BEFORE_TEXT : AFTER_TEXT),
      waits
    );
    expect(waits).toContain(5000);
    expect(stepJudge.mock.calls[1]?.[0].input.afterText).toBe(AFTER_TEXT);
    expect(v).toMatchObject({ verified: true });
  });

  it("keeps the strict submit judge for the genuine final step", async () => {
    submitJudge.mockResolvedValue({ verified: false, reason: "title still Sign In" });
    const v = await run(true, () => AFTER_TEXT);
    expect(stepJudge).not.toHaveBeenCalled();
    expect(submitJudge).toHaveBeenCalledTimes(1);
    const input = submitJudge.mock.calls[0]?.[0].input;
    expect(input.pageTitle).toBe("Sign In");
    expect(input.isFinalStep).toBe(true);
    expect(input.stepInstruction).toBe(STEP);
    expect(input.visibleText).toBe(AFTER_TEXT);
    expect(v).toEqual({ verified: false, reason: "title still Sign In" });
  });
});
