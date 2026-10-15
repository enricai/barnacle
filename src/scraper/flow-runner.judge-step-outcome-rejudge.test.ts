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

function run(reads: string[], waits: number[]): ReturnType<typeof judgeStepOutcome> {
  let i = 0;
  return judgeStepOutcome({
    client: {} as never,
    step: "click continue",
    isFinalStep: false,
    page: {
      waitForTimeout: async (ms: number) => {
        waits.push(ms);
      },
    },
    target: { evaluate: async () => reads[Math.min(i++, reads.length - 1)] ?? "" } as never,
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
    const v = await run(["a", "a", "a", "a", "a", "b"], waits);
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
    await run(["a", "b", "c"], waits);
    expect(stepJudge).toHaveBeenCalledTimes(1);
    expect(waits).not.toContain(5000);
  });

  it("keeps the first verdict when the second is null", async () => {
    stepJudge.mockResolvedValueOnce(NO).mockResolvedValueOnce(null);
    const v = await run(["a", "a", "a", "a", "a", "b"], []);
    expect(v).toEqual({ verified: false, reason: "no" });
  });
});
