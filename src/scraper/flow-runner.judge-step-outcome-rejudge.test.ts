import { beforeEach, describe, expect, it, vi } from "vitest";

const { stepJudge } = vi.hoisted(() => ({ stepJudge: vi.fn() }));

vi.mock("@/lib/llm/judges/verify-step-advanced", () => ({
  verifyStepAdvancedWithLLM: stepJudge,
}));

import { judgeStepOutcome } from "@/scraper/flow-runner";

const SUBMIT_INPUT = {
  pageUrl: "u",
  pageTitle: "t",
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
    url: async () => "u",
    evaluate: async (expr: string) => {
      if (expr.includes("__settleQ")) return { pending: 0, mutations: 0 };
      const t = read();
      if (expr.includes("outerHTML"))
        return { html: t.length, text: `${t.length}:${t.slice(0, 200)}`, values: "", state: "" };
      return t;
    },
  };
}

function run(reads: string[], waits: number[]): ReturnType<typeof judgeStepOutcome> {
  return judgeStepOutcome({
    client: {} as never,
    step: "click continue",
    isFinalStep: false,
    submitStep: false,
    flowHasSubmitSemantics: false,
    page: {
      waitForTimeout: async (ms: number) => {
        waits.push(ms);
      },
    },
    target: judgeTarget(
      () => reads[Math.min(stepJudge.mock.calls.length, reads.length - 1)] ?? ""
    ) as never,
    signalCounter: { n: 0 },
    preNetworkCount: 0,
    preVisibleTextSignature: "5:start",
    submitInput: SUBMIT_INPUT,
  });
}

const NO = { advanced: false, reason: "no" };
const YES = { advanced: true, reason: "yes" };

describe("judgeStepOutcome re-judge", () => {
  beforeEach(() => stepJudge.mockReset());

  it("re-judges once when advanced=false and text changed, returning the second verdict", async () => {
    stepJudge.mockResolvedValueOnce(NO).mockResolvedValueOnce(YES);
    const waits: number[] = [];
    const v = await run(["a", "b"], waits);
    expect(stepJudge).toHaveBeenCalledTimes(2);
    expect(waits).toContain(5000);
    expect(v).toMatchObject({ verified: true });
  });

  it("does not re-judge when text is unchanged", async () => {
    stepJudge.mockResolvedValue(NO);
    const v = await run(["same"], []);
    expect(stepJudge).toHaveBeenCalledTimes(1);
    expect(v).toEqual({ verified: false, reason: "no" });
  });

  it("never waits or re-judges on advanced=true", async () => {
    stepJudge.mockResolvedValue(YES);
    const waits: number[] = [];
    await run(["a", "a"], waits);
    expect(stepJudge).toHaveBeenCalledTimes(1);
    expect(waits).not.toContain(5000);
  });

  it("keeps the first verdict when the second is null", async () => {
    stepJudge.mockResolvedValueOnce(NO).mockResolvedValueOnce(null);
    const v = await run(["a", "b"], []);
    expect(v).toEqual({ verified: false, reason: "no" });
  });
});
