import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { STEP_ADVANCED_SYSTEM_PROMPT, verifyStepAdvancedWithLLM } from "./verify-step-advanced";

function fakeClient(parsedOutput: unknown): Anthropic {
  return {
    messages: {
      parse: vi.fn().mockResolvedValue({
        parsed_output: parsedOutput,
        content: [{ type: "text", text: JSON.stringify(parsedOutput) }],
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    },
  } as unknown as Anthropic;
}

const INPUT = {
  stepInstruction: "Click Create account",
  beforeText: "Create account email password",
  afterText: "Shipping address",
  invalidMarkerCount: 0,
};

describe("verifyStepAdvancedWithLLM", () => {
  it("truncates a 900-char reason to 400 chars instead of returning null", async () => {
    const client = fakeClient({ advanced: true, reason: "x".repeat(900) });
    const result = await verifyStepAdvancedWithLLM({ client, input: INPUT });
    expect(result?.advanced).toBe(true);
    expect(result?.reason).toHaveLength(400);
  });

  it("returns null for a null client", async () => {
    expect(await verifyStepAdvancedWithLLM({ client: null, input: INPUT })).toBeNull();
  });

  it("does not call messages.parse for a null client", async () => {
    const client = fakeClient({ advanced: true, reason: "x" });
    await verifyStepAdvancedWithLLM({ client: null, input: INPUT });
    expect(client.messages.parse).not.toHaveBeenCalled();
  });

  it("passes an advanced=false verdict through", async () => {
    const parsedOutput = { advanced: false, reason: "same form" };
    const client = fakeClient(parsedOutput);
    expect(await verifyStepAdvancedWithLLM({ client, input: INPUT })).toEqual(parsedOutput);
  });

  it("system prompt asks for one short sentence reason", async () => {
    const client = fakeClient({ advanced: true, reason: "x" });
    await verifyStepAdvancedWithLLM({ client, input: INPUT });
    const args = vi.mocked(client.messages.parse).mock.calls[0]?.[0] as unknown as {
      system: string;
    };
    expect(args.system).toBe(STEP_ADVANCED_SYSTEM_PROMPT);
    expect(args.system).toContain("one short sentence");
  });

  it("title and URL are not part of the input or prompt", async () => {
    const client = fakeClient({ advanced: true, reason: "x" });
    await verifyStepAdvancedWithLLM({ client, input: INPUT });
    const args = vi.mocked(client.messages.parse).mock.calls[0]?.[0] as unknown as {
      messages: { content: string }[];
    };
    expect(args.messages[0]?.content).not.toMatch(/title|url/i);
  });

  it("prompt carries before and after text", async () => {
    const client = fakeClient({ advanced: false, reason: "same form" });
    await verifyStepAdvancedWithLLM({ client, input: INPUT });
    const args = vi.mocked(client.messages.parse).mock.calls[0]?.[0] as unknown as {
      messages: { content: string }[];
    };
    expect(args.messages[0]?.content).toContain("Create account email password");
    expect(args.messages[0]?.content).toContain("Shipping address");
  });

  it("system prompt compares the current-step marker and limits failure to explicit errors", () => {
    expect(STEP_ADVANCED_SYSTEM_PROMPT).toContain("marked current");
    expect(STEP_ADVANCED_SYSTEM_PROMPT).toContain("Required-field markers");
    expect(STEP_ADVANCED_SYSTEM_PROMPT).toContain("not errors");
    expect(STEP_ADVANCED_SYSTEM_PROMPT).toContain("explicit error summary or message");
    expect(STEP_ADVANCED_SYSTEM_PROMPT).not.toContain("the same form");
  });

  it("carries a step-list page's before and after text verbatim", async () => {
    const client = fakeClient({ advanced: true, reason: "step 3 current" });
    const beforeText = "current step 2 of 7 My Information";
    const afterText = "step 2 of 7 My Information current step 3 of 7 My Experience Job Title *";
    await verifyStepAdvancedWithLLM({
      client,
      input: { ...INPUT, beforeText, afterText },
    });
    const args = vi.mocked(client.messages.parse).mock.calls[0]?.[0] as unknown as {
      messages: { content: string }[];
    };
    expect(args.messages[0]?.content).toContain(beforeText);
    expect(args.messages[0]?.content).toContain(afterText);
  });
});
