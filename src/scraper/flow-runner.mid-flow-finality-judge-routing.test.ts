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

const STEP =
  "On the account registration form (Email Address, Password and Verify New Password already filled), click the 'Create Account' button to submit the account creation form";
const BEFORE_TEXT = "Create Account Email Address Password Verify New Password";
const AFTER_TEXT = "Welcome! Your profile is ready. Continue to your dashboard";

const SUBMIT_INPUT = {
  pageUrl: "https://example.org/register",
  pageTitle: "Sign In",
  unfocusedObserve: [],
  networkCaptures: [],
  invalidMarkerCount: 0,
  ownBackendHostnames: [],
  successUrlFragments: [],
  successPageTitleHints: [],
  submittedStateSelectors: [],
};

function judgeTarget(text: string): {
  url: () => Promise<string>;
  evaluate: (expr: string) => Promise<unknown>;
} {
  return {
    url: async () => "https://example.org/register",
    evaluate: async (expr: string) => {
      if (expr.includes("__settleQ")) return { pending: 0, mutations: 0 };
      if (expr.includes("outerHTML"))
        return {
          html: text.length,
          text: `${text.length}:${text.slice(0, 200)}`,
          values: "",
          state: "",
        };
      return text;
    },
  };
}

function run(opts: {
  isFinalStep: boolean;
  flowHasSubmitSemantics: boolean;
}): ReturnType<typeof judgeStepOutcome> {
  return judgeStepOutcome({
    client: {} as never,
    step: STEP,
    isFinalStep: opts.isFinalStep,
    submitStep: true,
    flowHasSubmitSemantics: opts.flowHasSubmitSemantics,
    page: { waitForTimeout: async () => undefined },
    target: judgeTarget(AFTER_TEXT) as never,
    signalCounter: { n: 0 },
    preNetworkCount: 0,
    preVisibleTextSignature: `${BEFORE_TEXT.length}:${BEFORE_TEXT}`,
    preVisibleText: BEFORE_TEXT,
    submitInput: SUBMIT_INPUT,
  });
}

describe("judgeStepOutcome mid-flow finality routing", () => {
  beforeEach(() => {
    stepJudge.mockReset();
    submitJudge.mockReset();
  });

  it("routes a last-slot submit-shaped click without submit semantics to the step judge despite a stale title", async () => {
    stepJudge.mockResolvedValue({ advanced: true, reason: "new page" });
    const v = await run({ isFinalStep: true, flowHasSubmitSemantics: false });
    expect(submitJudge).not.toHaveBeenCalled();
    expect(stepJudge).toHaveBeenCalledTimes(1);
    const input = stepJudge.mock.calls[0]?.[0].input;
    expect(input.beforeText).toBe(BEFORE_TEXT);
    expect(input.afterText).toBe(AFTER_TEXT);
    expect(Object.keys(input)).not.toContain("pageTitle");
    expect(v).toMatchObject({ verified: true });
  });

  it("keeps the strict submit judge for a genuine final step", async () => {
    submitJudge.mockResolvedValue({ verified: false, reason: "strict" });
    const v = await run({ isFinalStep: true, flowHasSubmitSemantics: true });
    expect(submitJudge).toHaveBeenCalledTimes(1);
    expect(stepJudge).not.toHaveBeenCalled();
    expect(v).toEqual({ verified: false, reason: "strict" });
  });

  it("routes a non-final step to the step judge regardless of submit semantics", async () => {
    stepJudge.mockResolvedValue({ advanced: true, reason: "yes" });
    const v = await run({ isFinalStep: false, flowHasSubmitSemantics: true });
    expect(submitJudge).not.toHaveBeenCalled();
    expect(stepJudge).toHaveBeenCalledTimes(1);
    expect(v).toMatchObject({ verified: true });
  });
});
