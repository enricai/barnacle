/**
 * Unit coverage for the select-option picker judge. Verifies:
 *  - returns the parsed { chosenIndex } from a mocked Haiku client
 *  - null client (Bedrock-only) short-circuits to null with no call
 *  - empty availableOptions short-circuits to null
 *  - an out-of-range chosenIndex is clamped to null (guards the caller)
 */

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { judgeSelectOptionWithLLM } from "./select-option";

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

describe("judgeSelectOptionWithLLM", () => {
  it("returns the chosen index from the mocked judge", async () => {
    const client = fakeClient({ chosenIndex: 2, reason: "closest clinical specialty" });
    const result = await judgeSelectOptionWithLLM({
      client,
      input: {
        questionLabel: "Which best describes your current or most recent experience?",
        desiredHint: "Emergency Department",
        availableOptions: ["Behavioral Health", "CVICU", "Progressive Care"],
      },
    });
    expect(result).toEqual({ chosenIndex: 2, reason: "closest clinical specialty" });
  });

  it("short-circuits to null when the client is null (Bedrock-only)", async () => {
    const result = await judgeSelectOptionWithLLM({
      client: null,
      input: { questionLabel: "Q", desiredHint: "X", availableOptions: ["a", "b"] },
    });
    expect(result).toBeNull();
  });

  it("short-circuits to null when there are no options", async () => {
    const client = fakeClient({ chosenIndex: 0, reason: "n/a" });
    const result = await judgeSelectOptionWithLLM({
      client,
      input: { questionLabel: "Q", desiredHint: "X", availableOptions: [] },
    });
    expect(result).toBeNull();
    expect(client.messages.parse as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("clamps an out-of-range chosenIndex to null so the caller can't index past the array", async () => {
    const client = fakeClient({ chosenIndex: 9, reason: "hallucinated index" });
    const result = await judgeSelectOptionWithLLM({
      client,
      input: { questionLabel: "Q", desiredHint: "X", availableOptions: ["a", "b"] },
    });
    expect(result?.chosenIndex).toBeNull();
  });
});
