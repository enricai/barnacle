/**
 * Unit coverage for the error-messages extraction judge. Verifies:
 *  - returns the parsed messages from a mocked client
 *  - null client (Bedrock-only) short-circuits to null with no call
 *  - empty body HTML excerpt short-circuits to null
 */

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { judgeErrorMessagesWithLLM } from "./error-messages";

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

describe("judgeErrorMessagesWithLLM", () => {
  it("returns the parsed messages from the mocked judge", async () => {
    const parsedOutput = [
      { text: "Email is required", fieldHint: "email", severity: "error" },
    ];
    const client = fakeClient(parsedOutput);
    const result = await judgeErrorMessagesWithLLM({
      client,
      input: { bodyHtmlExcerpt: "<span class='error'>Email is required</span>" },
    });
    expect(result).toEqual(parsedOutput);
  });

  it("short-circuits to null when the client is null (Bedrock-only)", async () => {
    const result = await judgeErrorMessagesWithLLM({
      client: null,
      input: { bodyHtmlExcerpt: "<div>content</div>" },
    });
    expect(result).toBeNull();
  });

  it("short-circuits to null when the body HTML excerpt is empty", async () => {
    const client = fakeClient([]);
    const result = await judgeErrorMessagesWithLLM({
      client,
      input: { bodyHtmlExcerpt: "" },
    });
    expect(result).toBeNull();
    expect(client.messages.parse as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});
