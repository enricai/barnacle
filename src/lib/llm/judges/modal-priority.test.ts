/**
 * Unit coverage for the modal-priority judge. Verifies:
 *  - returns the parsed priority indices from a mocked client
 *  - null client (Bedrock-only) short-circuits to null with no call
 *  - empty observations short-circuits to null
 */

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { judgeModalPriorityWithLLM } from "./modal-priority";

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

const OBSERVATIONS = [
  { description: "cookie consent banner", selector: "#cookie-banner" },
  { description: "sidebar navigation", selector: "#sidebar" },
];

describe("judgeModalPriorityWithLLM", () => {
  it("returns the priority indices from the mocked judge", async () => {
    const parsedOutput = { priorityIndices: [0], rationale: "cookie banner blocks the form" };
    const client = fakeClient(parsedOutput);
    const result = await judgeModalPriorityWithLLM({
      client,
      input: { observations: OBSERVATIONS },
    });
    expect(result).toEqual(parsedOutput);
  });

  it("short-circuits to null when the client is null (Bedrock-only)", async () => {
    const result = await judgeModalPriorityWithLLM({
      client: null,
      input: { observations: OBSERVATIONS },
    });
    expect(result).toBeNull();
  });

  it("short-circuits to null when there are no observations", async () => {
    const client = fakeClient({ priorityIndices: [], rationale: "n/a" });
    const result = await judgeModalPriorityWithLLM({
      client,
      input: { observations: [] },
    });
    expect(result).toBeNull();
    expect(client.messages.parse as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});
