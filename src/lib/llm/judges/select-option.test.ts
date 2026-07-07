/**
 * Unit coverage for the select-option picker judge. Verifies:
 *  - returns the parsed { selectIndex, optionIndex } from a mocked client
 *  - null client (Bedrock-only) short-circuits to null with no call
 *  - empty candidates short-circuits to null
 *  - an out-of-range selectIndex / optionIndex is clamped to null (guards the caller)
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

const CANDIDATES = [
  { label: "disability", options: ["Yes", "No", "I do not wish to answer"] },
  { label: "nursing education", options: ["ADN", "BSN", "MSN"] },
];

describe("judgeSelectOptionWithLLM", () => {
  it("returns the chosen dropdown + option from the mocked judge", async () => {
    const client = fakeClient({ selectIndex: 1, optionIndex: 1, reason: "BSN answers education" });
    const result = await judgeSelectOptionWithLLM({
      client,
      input: {
        questionLabel: "What is your highest level of nursing education?",
        desiredHint: "Bachelors of Science in Nursing completed",
        candidates: CANDIDATES,
      },
    });
    expect(result).toEqual({ selectIndex: 1, optionIndex: 1, reason: "BSN answers education" });
  });

  it("short-circuits to null when the client is null (Bedrock-only)", async () => {
    const result = await judgeSelectOptionWithLLM({
      client: null,
      input: { questionLabel: "Q", desiredHint: "X", candidates: CANDIDATES },
    });
    expect(result).toBeNull();
  });

  it("short-circuits to null when there are no candidate dropdowns", async () => {
    const client = fakeClient({ selectIndex: 0, optionIndex: 0, reason: "n/a" });
    const result = await judgeSelectOptionWithLLM({
      client,
      input: { questionLabel: "Q", desiredHint: "X", candidates: [] },
    });
    expect(result).toBeNull();
    expect(client.messages.parse as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("clamps an out-of-range selectIndex to null", async () => {
    const client = fakeClient({ selectIndex: 5, optionIndex: 0, reason: "hallucinated" });
    const result = await judgeSelectOptionWithLLM({
      client,
      input: { questionLabel: "Q", desiredHint: "X", candidates: CANDIDATES },
    });
    expect(result?.selectIndex).toBeNull();
  });

  it("clamps an out-of-range optionIndex (for the chosen dropdown) to null", async () => {
    const client = fakeClient({ selectIndex: 0, optionIndex: 9, reason: "hallucinated option" });
    const result = await judgeSelectOptionWithLLM({
      client,
      input: { questionLabel: "Q", desiredHint: "X", candidates: CANDIDATES },
    });
    expect(result?.selectIndex).toBeNull();
    expect(result?.optionIndex).toBeNull();
  });

  it("passes through a null selectIndex (no dropdown fits)", async () => {
    const client = fakeClient({ selectIndex: null, optionIndex: null, reason: "none fit" });
    const result = await judgeSelectOptionWithLLM({
      client,
      input: { questionLabel: "Q", desiredHint: "X", candidates: CANDIDATES },
    });
    expect(result).toEqual({ selectIndex: null, optionIndex: null, reason: "none fit" });
  });
});
