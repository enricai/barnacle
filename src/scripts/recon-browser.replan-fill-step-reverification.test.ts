import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LlmCallInput } from "@/lib/telemetry/call-capture";
import { CALL_TYPE_RECON_REPLAN } from "@/lib/telemetry/call-types";
import { replanRemainingFlow } from "@/scripts/recon-browser";

/**
 * Pins bugfix-003's contract: the replan prompt must call out fill-shaped
 * completed steps for re-verification against the failure-time DOM, and must
 * NOT apply that same instruction to non-fill completed steps (e.g. clicks),
 * which stay covered only by the blanket "do NOT re-emit" guidance.
 */

function makeReplanClient(): Anthropic {
  return {
    messages: {
      parse: vi.fn().mockResolvedValue({
        parsed_output: { outcome: "replan", steps: ["Click Submit"] },
        content: [{ type: "text", text: "{}" }],
        usage: { input_tokens: 100, output_tokens: 5 },
      }),
    },
  } as unknown as Anthropic;
}

function makePageStub(): { url: () => string; title: () => Promise<string> } {
  return {
    url: () => "https://example.com/apply",
    title: vi.fn().mockResolvedValue("Application Form"),
  };
}

function makeStagehandStub(): { observe: ReturnType<typeof vi.fn> } {
  return {
    observe: vi.fn().mockResolvedValue([]),
  };
}

function makeCaptureFn(): {
  fn: (input: LlmCallInput) => Promise<void>;
  calls: LlmCallInput[];
} {
  const calls: LlmCallInput[] = [];
  return {
    fn: async (input: LlmCallInput): Promise<void> => {
      calls.push(input);
    },
    calls,
  };
}

describe("replanRemainingFlow — fill-step re-verification prompt section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names the fill-shaped completed step's field/value with a verify-against-failure-DOM instruction, and does not tag a non-fill completed step with it", async () => {
    const client = makeReplanClient();
    const { fn, calls } = makeCaptureFn();

    await replanRemainingFlow({
      client,
      originalFlow: [
        "Fill in the Email field with 'jane@example.com'",
        "Click the 'Create Account' button",
      ],
      completedSteps: [
        "Fill in the Email field with 'jane@example.com'",
        "Click the 'Create Account' button",
      ],
      failedStep: "Fill in the City field with 'San Francisco'",
      remainingSteps: [],
      failureDumpPath: "/tmp/nonexistent-dump.json",
      page: makePageStub() as never,
      stagehand: makeStagehandStub() as never,
      captureFn: fn,
    });

    const prompt = calls.find((c) => c.callType === CALL_TYPE_RECON_REPLAN)?.userContent ?? "";

    expect(prompt).toContain("FILL-STEP RE-VERIFICATION");
    expect(prompt).toContain("PAGE BODY HTML AT FAILURE");
    expect(prompt).toContain("Email");
    expect(prompt).toContain("jane@example.com");

    const reverificationStart = prompt.indexOf("FILL-STEP RE-VERIFICATION");
    const reverificationEnd = prompt.indexOf("THE STEP THAT JUST FAILED", reverificationStart);
    const reverificationSection = prompt.slice(reverificationStart, reverificationEnd);
    expect(reverificationSection).not.toContain("Create Account");
  });

  it("omits the FILL-STEP RE-VERIFICATION section entirely when no completed step is fill-shaped", async () => {
    const client = makeReplanClient();
    const { fn, calls } = makeCaptureFn();

    await replanRemainingFlow({
      client,
      originalFlow: ["Click the 'Create Account' button"],
      completedSteps: ["Click the 'Create Account' button"],
      failedStep: "Click the 'Submit' button",
      remainingSteps: [],
      failureDumpPath: "/tmp/nonexistent-dump.json",
      page: makePageStub() as never,
      stagehand: makeStagehandStub() as never,
      captureFn: fn,
    });

    const prompt = calls.find((c) => c.callType === CALL_TYPE_RECON_REPLAN)?.userContent ?? "";

    expect(prompt).not.toContain("FILL-STEP RE-VERIFICATION");
  });
});
