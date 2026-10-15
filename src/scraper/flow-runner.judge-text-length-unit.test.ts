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

function run(body: string, pre: string): ReturnType<typeof judgeStepOutcome> {
  return judgeStepOutcome({
    client: {} as never,
    step: "click continue",
    isFinalStep: false,
    page: { waitForTimeout: async () => {} },
    target: { evaluate: async () => body } as never,
    signalCounter: { n: 0 },
    preNetworkCount: 0,
    preVisibleTextSignature: pre,
    submitInput: SUBMIT_INPUT,
  });
}

describe("judgeStepOutcome text length unit", () => {
  beforeEach(() => stepJudge.mockReset());

  it("strips the length prefix and collapses whitespace in beforeText", async () => {
    stepJudge.mockResolvedValue({ advanced: true, reason: "y" });
    await run("x", "5000:a  b\n\n c");
    expect(stepJudge.mock.calls[0][0].input.beforeText).toBe("a b c");
  });

  it("settles on the raw length for bodies over 3000 chars", async () => {
    stepJudge.mockResolvedValue({ advanced: true, reason: "y" });
    const body = "z".repeat(5000);
    const waits: number[] = [];
    const pre = `${body.length}:${body.slice(0, 200)}`;
    await run(body, pre);
    expect(waits).toEqual([]);
    expect(stepJudge.mock.calls[0][0].input.beforeText).toBe(body.slice(0, 200));
  });
});
