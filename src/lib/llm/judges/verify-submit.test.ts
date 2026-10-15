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

  it("non-final step: stale title contradicting visible text still yields verified=true", async () => {
    const parsedOutput = { verified: true, reason: "visible text shows next stage" };
    const client = fakeClient(parsedOutput);
    const result = await verifySubmitWithLLM({
      client,
      input: {
        ...INPUT,
        pageTitle: "Sign In",
        stepInstruction: "Click Create account",
        isFinalStep: false,
        visibleText: "Shipping address",
      },
    });
    const args = vi.mocked(client.messages.parse).mock.calls[0]?.[0] as unknown as {
      system: string;
      messages: { content: string }[];
    };
    expect(result).toEqual(parsedOutput);
    expect(args.messages[0]?.content).not.toContain("PAGE TITLE");
    expect(args.messages[0]?.content).not.toContain("Sign In");
    expect(args.messages[0]?.content).not.toContain("Success page title hints");
    expect(args.messages[0]?.content).toContain("Shipping address");
  });

  it("gives the judge the live visible text rather than only the stale document title", async () => {
    const parsedOutput = { verified: true, reason: "visible text shows the next stage" };
    const client = fakeClient(parsedOutput);
    const result = await verifySubmitWithLLM({
      client,
      input: {
        ...INPUT,
        pageTitle: "Sign In",
        stepInstruction: "Click Sign in",
        isFinalStep: false,
        visibleText: "Settings Candidate Home",
      },
    });
    const args = vi.mocked(client.messages.parse).mock.calls[0]?.[0] as unknown as {
      system: string;
      messages: { content: string }[];
    };
    const user = args.messages[0]?.content ?? "";
    expect(result).toEqual(parsedOutput);
    expect(user).toContain("Settings Candidate Home");
    expect(user).toContain("Click Sign in");
    expect(user).not.toContain("Sign In");
    expect(args.system).toContain("title is not evidence");
  });

  it("final step: prompt still presents title and title hints as evidence", async () => {
    const { user } = await captured({ isFinalStep: true, pageTitle: "Sign In" });
    expect(user).toContain("PAGE TITLE: Sign In");
    expect(user).toContain("Success page title hints");
  });

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
    const parsedOutput = { verified: false, reason: "no confirmation signal. ".repeat(400) };
    const client = fakeClient(parsedOutput);
    const result = await verifySubmitWithLLM({
      client,
      input: { ...INPUT, isFinalStep: true },
    });
    expect(result).not.toBeNull();
    expect(result).toEqual(parsedOutput);
  });
  it("defaults to strict final-step judging when isFinalStep is omitted", async () => {
    const { system, user } = await captured({
      stepInstruction: "Place order",
      pageTitle: "Sign In",
      visibleText: "Shipping address",
    });
    expect(system).toBe(SUBMIT_VERIFY_SYSTEM_PROMPT);
    expect(user).toContain("FINAL STEP OF FLOW: yes");
    expect(user).toContain("PAGE TITLE: Sign In");
    expect(user).toContain("Success page title hints");
  });

  it("tells the judge a stale title is not evidence only for non-final steps", async () => {
    const nonFinal = await captured({ stepInstruction: "Next", isFinalStep: false });
    expect(nonFinal.system).toContain("title is not evidence");
    expect(nonFinal.system.startsWith(SUBMIT_VERIFY_SYSTEM_PROMPT)).toBe(true);
    expect(nonFinal.user).not.toContain("PAGE TITLE");
  });
});
