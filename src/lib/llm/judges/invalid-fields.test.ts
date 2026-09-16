/**
 * Unit coverage for the invalid-fields detection judge. Verifies:
 *  - returns the parsed verdict from a mocked client
 *  - null client (Bedrock-only) short-circuits to null with no call
 */

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { judgeInvalidFieldsWithLLM } from "./invalid-fields";

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

describe("judgeInvalidFieldsWithLLM", () => {
  it("returns the parsed verdict from the mocked judge", async () => {
    const parsedOutput = {
      present: true,
      fields: [
        {
          containerXpath: "//div[1]",
          label: "Email",
          markerKind: "aria",
          framework: "react",
        },
      ],
    };
    const client = fakeClient(parsedOutput);
    const result = await judgeInvalidFieldsWithLLM({
      client,
      input: {
        bodyHtmlExcerpt: "<div aria-invalid='true'>Email</div>",
        knownErrorClassPrefixes: [],
      },
    });
    expect(result).toEqual(parsedOutput);
  });

  it("short-circuits to null when the client is null (Bedrock-only)", async () => {
    const result = await judgeInvalidFieldsWithLLM({
      client: null,
      input: { bodyHtmlExcerpt: "<div>content</div>", knownErrorClassPrefixes: [] },
    });
    expect(result).toBeNull();
  });

  it("still calls the judge when the body HTML excerpt is empty (no empty-input guard)", async () => {
    const parsedOutput = { present: false, fields: [] };
    const client = fakeClient(parsedOutput);
    const result = await judgeInvalidFieldsWithLLM({
      client,
      input: { bodyHtmlExcerpt: "", knownErrorClassPrefixes: [] },
    });
    expect(result).toEqual(parsedOutput);
    expect(client.messages.parse as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });
});
