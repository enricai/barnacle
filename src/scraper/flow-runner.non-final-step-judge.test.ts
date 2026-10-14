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
});
