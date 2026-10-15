import { describe, expect, it, vi } from "vitest";

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

function fakeTarget(reads: string[]): { evaluate: () => Promise<string> } {
  let i = 0;
  return { evaluate: async () => reads[Math.min(i++, reads.length - 1)] ?? "" };
}

const SUBMIT_INPUT = {
  pageUrl: "u",
  pageTitle: "t",
  unfocusedObserve: [],
  networkCaptures: [],
  invalidMarkerCount: 2,
  ownBackendHostnames: [],
  successUrlFragments: [],
  successPageTitleHints: [],
  submittedStateSelectors: [],
};

function params(isFinalStep: boolean, reads: string[]): Parameters<typeof judgeStepOutcome>[0] {
  return {
    client: {} as never,
    step: "click continue",
    isFinalStep,
    page: { waitForTimeout: async () => {} },
    target: fakeTarget(reads) as never,
    signalCounter: { n: 0 },
    preNetworkCount: 0,
    preVisibleTextSignature: "12:Create account",
    submitInput: SUBMIT_INPUT,
  };
}

describe("judgeStepOutcome", () => {
  it("judges a non-final step on the settled post-click text", async () => {
    stepJudge.mockResolvedValue({ advanced: true, reason: "moved on" });
    const verdict = await judgeStepOutcome(
      params(false, ["Create account", "Loading", "Shipping", "Shipping"])
    );
    expect(submitJudge).not.toHaveBeenCalled();
    const input = stepJudge.mock.calls[0]?.[0].input;
    expect(input?.beforeText).toBe("Create account");
    expect(input?.afterText).toBe("Shipping");
    expect(input?.invalidMarkerCount).toBe(2);
    expect(verdict).toMatchObject({ verified: true, rationale: "moved on" });
  });

  it("maps a not-advanced verdict and a null verdict", async () => {
    stepJudge.mockResolvedValueOnce({ advanced: false, reason: "same form" });
    expect(await judgeStepOutcome(params(false, ["x"]))).toEqual({
      verified: false,
      reason: "same form",
    });
    stepJudge.mockResolvedValueOnce(null);
    expect(await judgeStepOutcome(params(false, ["x"]))).toBeNull();
  });

  it("delegates the final step to the submit judge", async () => {
    stepJudge.mockClear();
    submitJudge.mockResolvedValue({ verified: false, reason: "r" });
    await judgeStepOutcome(params(true, ["body"]));
    expect(stepJudge).not.toHaveBeenCalled();
    const input = submitJudge.mock.calls[0]?.[0].input;
    expect(input).toMatchObject({
      isFinalStep: true,
      visibleText: "body",
      stepInstruction: "click continue",
    });
  });

  describe("re-judge after a mid-transition render", () => {
    const NO = { advanced: false, reason: "no" };

    function rejudgeParams(
      reads: string[],
      waits: number[]
    ): Parameters<typeof judgeStepOutcome>[0] {
      return {
        ...params(false, []),
        page: { waitForTimeout: async (ms: number) => void waits.push(ms) },
        target: {
          evaluate: async () =>
            reads[Math.min(stepJudge.mock.calls.length, reads.length - 1)] ?? "",
        } as never,
      };
    }

    it("waits 5s and returns the second verdict when the text changed", async () => {
      stepJudge.mockReset();
      stepJudge.mockResolvedValueOnce(NO).mockResolvedValueOnce({ advanced: true, reason: "yes" });
      const waits: number[] = [];
      const verdict = await judgeStepOutcome(rejudgeParams(["a", "b"], waits));
      expect(waits).toContain(5000);
      expect(stepJudge).toHaveBeenCalledTimes(2);
      expect(verdict).toMatchObject({ verified: true });
    });

    it("judges once when the later read is identical", async () => {
      stepJudge.mockReset();
      stepJudge.mockResolvedValue(NO);
      const verdict = await judgeStepOutcome(rejudgeParams(["same"], []));
      expect(stepJudge).toHaveBeenCalledTimes(1);
      expect(verdict).toEqual({ verified: false, reason: "no" });
    });

    it("adds no extra wait or call when the first verdict advanced", async () => {
      stepJudge.mockReset();
      stepJudge.mockResolvedValue({ advanced: true, reason: "yes" });
      const waits: number[] = [];
      await judgeStepOutcome(rejudgeParams(["a", "b"], waits));
      expect(stepJudge).toHaveBeenCalledTimes(1);
      expect(waits).not.toContain(5000);
    });

    it("keeps the first verdict when the second judge returns null", async () => {
      stepJudge.mockReset();
      stepJudge.mockResolvedValueOnce(NO).mockResolvedValueOnce(null);
      const verdict = await judgeStepOutcome(rejudgeParams(["a", "b"], []));
      expect(verdict).toEqual({ verified: false, reason: "no" });
    });
  });
});
