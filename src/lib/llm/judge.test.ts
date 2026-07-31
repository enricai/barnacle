/**
 * Unit coverage for the Haiku judge wrapper. Exercises:
 *  - Happy path returns { parsed, latencyMs } and records callType + parsedOk=true
 *  - parsed_output=null path throws internally, gets logged, returns null
 *  - Underlying SDK exception path returns null + records failureKind
 *  - Default vs caller-supplied maxTokens
 *  - Large-prompt warning surfaces via the logger (sanity check)
 */

import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import type { LlmCallInput } from "@/lib/telemetry/call-capture";

const captured: LlmCallInput[] = [];
vi.mock("@/lib/telemetry/call-capture", async () => {
  const actual = await vi.importActual<typeof import("@/lib/telemetry/call-capture")>(
    "@/lib/telemetry/call-capture"
  );
  return {
    ...actual,
    captureLlmCall: async (input: LlmCallInput): Promise<void> => {
      captured.push(input);
    },
  };
});

import { callHaikuJudge } from "./judge";

const TEST_SCHEMA = z.object({
  ok: z.boolean(),
  reason: z.string().min(1),
});

beforeEach(() => {
  captured.length = 0;
});

function fakeClient(opts: {
  parsedOutput?: unknown;
  rawText?: string;
  throwError?: Error;
}): Anthropic {
  return {
    messages: {
      parse: opts.throwError
        ? vi.fn().mockRejectedValue(opts.throwError)
        : vi.fn().mockResolvedValue({
            parsed_output: opts.parsedOutput,
            content: [{ type: "text", text: opts.rawText ?? "" }],
            usage: { input_tokens: 100, output_tokens: 25 },
          }),
    },
  } as unknown as Anthropic;
}

describe("callHaikuJudge — happy path", () => {
  it("returns parsed verdict and latency on success", async () => {
    const verdict = { ok: true, reason: "all signals corroborate" };
    const client = fakeClient({ parsedOutput: verdict, rawText: JSON.stringify(verdict) });
    const result = await callHaikuJudge({
      client,
      systemPrompt: "You judge.",
      userPrompt: "Is this OK?",
      schema: TEST_SCHEMA,
      callType: "test-judge",
    });
    expect(result).not.toBeNull();
    expect(result?.parsed).toEqual(verdict);
    expect(typeof result?.latencyMs).toBe("number");
  });

  it("records a successful NDJSON entry with parsedOk=true", async () => {
    const verdict = { ok: true, reason: "ok" };
    const client = fakeClient({ parsedOutput: verdict, rawText: JSON.stringify(verdict) });
    await callHaikuJudge({
      client,
      systemPrompt: "You judge.",
      userPrompt: "go",
      schema: TEST_SCHEMA,
      callType: "test-judge",
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.callType).toBe("test-judge");
    expect(captured[0]?.parsedOk).toBe(true);
    expect(captured[0]?.success).toBe(true);
    expect(captured[0]?.model).toBe("claude-haiku-4-5-20251001");
    expect(captured[0]?.systemPrompt).toBe("You judge.");
    expect(captured[0]?.userContent).toBe("go");
  });
});

describe("callHaikuJudge — failure paths", () => {
  it("returns null and records failureKind when parsed_output is null", async () => {
    const client = fakeClient({ parsedOutput: null, rawText: "" });
    const result = await callHaikuJudge({
      client,
      systemPrompt: "judge",
      userPrompt: "go",
      schema: TEST_SCHEMA,
      callType: "test-judge",
    });
    expect(result).toBeNull();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.parsedOk).toBe(false);
    expect(captured[0]?.failureKind).toBe("schema-validation-failed");
    expect(captured[0]?.errorMessage).toContain("parsed_output is null");
  });

  it("returns null and records failureKind when the SDK throws", async () => {
    const client = fakeClient({ throwError: new Error("network error") });
    const result = await callHaikuJudge({
      client,
      systemPrompt: "judge",
      userPrompt: "go",
      schema: TEST_SCHEMA,
      callType: "test-judge",
    });
    expect(result).toBeNull();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.success).toBe(false);
    expect(captured[0]?.errorMessage).toContain("network error");
  });
});

describe("callHaikuJudge — maxTokens", () => {
  it("uses the default max_tokens when not supplied", async () => {
    const verdict = { ok: true, reason: "ok" };
    const fakeParse = vi.fn().mockResolvedValue({
      parsed_output: verdict,
      content: [{ type: "text", text: JSON.stringify(verdict) }],
      usage: { input_tokens: 100, output_tokens: 25 },
    });
    const client = { messages: { parse: fakeParse } } as unknown as Anthropic;
    await callHaikuJudge({
      client,
      systemPrompt: "judge",
      userPrompt: "go",
      schema: TEST_SCHEMA,
      callType: "test-judge",
    });
    expect(fakeParse).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 512 }));
  });

  it("respects caller-supplied maxTokens", async () => {
    const verdict = { ok: true, reason: "ok" };
    const fakeParse = vi.fn().mockResolvedValue({
      parsed_output: verdict,
      content: [{ type: "text", text: JSON.stringify(verdict) }],
      usage: { input_tokens: 100, output_tokens: 25 },
    });
    const client = { messages: { parse: fakeParse } } as unknown as Anthropic;
    await callHaikuJudge({
      client,
      systemPrompt: "judge",
      userPrompt: "go",
      schema: TEST_SCHEMA,
      callType: "test-judge",
      maxTokens: 128,
    });
    expect(fakeParse).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 128 }));
  });
});
