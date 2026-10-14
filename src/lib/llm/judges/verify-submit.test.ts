/**
 * Unit coverage for the submit-verification judge. Verifies:
 *  - returns the parsed verdict from a mocked client
 *  - null client (Bedrock-only) short-circuits to null with no call
 *
 * No empty-input guard beyond client===null: its input is a flat evidence
 * object, not a candidates/observations array.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  SUBMIT_VERIFY_SYSTEM_PROMPT,
  type VerifySubmitInput,
  verifySubmitWithLLM,
} from "./verify-submit";

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

const INPUT: VerifySubmitInput = {
  pageUrl: "https://example.com/applied",
  pageTitle: "Application submitted",
  unfocusedObserve: [],
  networkCaptures: [],
  invalidMarkerCount: 0,
  ownBackendHostnames: ["example.com"],
  successUrlFragments: ["/applied"],
  successPageTitleHints: ["submitted"],
  submittedStateSelectors: [],
};

describe("verifySubmitWithLLM", () => {
  it("returns the parsed verdict from the mocked judge", async () => {
    const parsedOutput = { verified: true, reason: "URL transitioned to /applied" };
    const client = fakeClient(parsedOutput);
    const result = await verifySubmitWithLLM({ client, input: INPUT });
    expect(result).toEqual(parsedOutput);
  });

  it("short-circuits to null when the client is null (Bedrock-only)", async () => {
    const result = await verifySubmitWithLLM({ client: null, input: INPUT });
    expect(result).toBeNull();
  });

  const captured = async (
    extra: Partial<VerifySubmitInput>
  ): Promise<{ system: string; user: string }> => {
    const client = fakeClient({ verified: true, reason: "x" });
    await verifySubmitWithLLM({ client, input: { ...INPUT, ...extra } });
    const args = vi.mocked(client.messages.parse).mock.calls[0]?.[0] as unknown as {
      system: string;
      messages: { content: string }[];
    };
    return { system: args.system, user: args.messages[0]?.content ?? "" };
  };

  it("final step: keeps confirmation-signal requirement and omits the title relaxation", async () => {
    const { system } = await captured({ isFinalStep: true, pageTitle: "Sign In" });
    expect(system).toContain("strong DOM/URL/title signal");
  });

  it("final step: strict rule only", async () => {
    const { system } = await captured({ stepInstruction: "Place order", isFinalStep: true });
    expect(system).toBe(SUBMIT_VERIFY_SYSTEM_PROMPT);
    expect(system).toContain("Strictness rule for verified=true");
  });

  it("final step: a very long reason is not rejected", async () => {
    const parsedOutput = { verified: true, reason: "confirmation banner shown. ".repeat(400) };
    const client = fakeClient(parsedOutput);
    const result = await verifySubmitWithLLM({
      client,
      input: { ...INPUT, isFinalStep: true },
    });
    expect(result).not.toBeNull();
    expect(result).toEqual(parsedOutput);
  });
});
