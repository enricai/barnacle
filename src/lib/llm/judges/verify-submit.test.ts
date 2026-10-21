/**
 * Unit coverage for the submit-verification judge. Verifies:
 *  - returns the parsed verdict from a mocked client
 *  - null client (Bedrock-only) short-circuits to null with no call
 *
 * No empty-input guard beyond client===null: its input is a flat evidence
 * object, not a candidates/observations array.
 */

import { readFileSync } from "node:fs";

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
  isFinalStep: true,
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
  it("keeps strict final-step judging when isFinalStep is true", async () => {
    const { system, user } = await captured({
      stepInstruction: "Place order",
      isFinalStep: true,
      pageTitle: "Sign In",
      visibleText: "Shipping address",
    });
    expect(system).toBe(SUBMIT_VERIFY_SYSTEM_PROMPT);
    expect(user).toContain("FINAL STEP OF FLOW: yes");
    expect(user).toContain("PAGE TITLE: Sign In");
    expect(user).toContain("Success page title hints");
  });

  it("recon-browser trailing-grace judges through judgeStepOutcome with positional finality, not a direct final-strict call", () => {
    const recon = readFileSync("src/scripts/recon-browser.ts", "utf8");
    expect(recon).not.toContain("await verifySubmitWithLLM(");
    const call = recon.slice(
      recon.indexOf("await judgeStepOutcome({", recon.indexOf("const trailingGraceVerdict ="))
    );
    const ctx = call.slice(0, call.indexOf("submitInput:"));
    expect(ctx).toContain("isFinalStep: i === plan.length - 1");
    expect(ctx).not.toContain("isFinalStep: true");
  });

  it("flow-runner derives finality from the full flow's steps, never a slice", () => {
    const runner = readFileSync("src/scraper/flow-runner.ts", "utf8");
    expect(runner).toContain("isFinalStep: i === steps.length - 1,");
    expect(runner).toContain("totalSteps: () => steps.length,");
  });
});
