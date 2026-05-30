/**
 * Unit tests for the LLM call-capture instrumentation in recon-browser.ts.
 * All tests stub the Anthropic SDK and inject a fake capture sink so no real
 * network calls or Steel sessions occur.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config", () => ({
  config: {
    scraper: {
      useBedrock: false,
      anthropicApiKey: "test-key",
      model: "anthropic/claude-sonnet-4-6",
      proxyType: "residential",
      steelSessionTimeoutMs: 30000,
    },
    telemetry: {
      callsNdjsonPath: ".barnacle/calls.ndjson",
    },
  },
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));
vi.mock("@/scraper/session", () => ({ createBrowserSession: vi.fn() }));
vi.mock("@/scraper/errors", () => ({
  StepVerificationError: class StepVerificationError extends Error {
    constructor(message = "step failed") {
      super(message);
    }
  },
}));

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({
  getLogger: () => loggerStub,
  getScriptLogger: () => loggerStub,
}));

vi.mock("@/lib/telemetry/call-capture", () => ({
  captureLlmCall: vi.fn().mockResolvedValue(undefined),
}));

import type { LlmCallInput } from "@/lib/telemetry/call-capture";
import { CALL_TYPE_RECON_REPHRASE } from "@/lib/telemetry/call-types";
import { rephraseWithLLM } from "@/scripts/recon-browser";

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeAnthropicClient(responseText: string, inputTokens = 50, outputTokens = 10): Anthropic {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: responseText }],
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      }),
    },
  } as unknown as Anthropic;
}

function makeCaptureFn(): {
  fn: (input: LlmCallInput) => Promise<void>;
  calls: LlmCallInput[];
} {
  const calls: LlmCallInput[] = [];
  return {
    fn: async (input: LlmCallInput): Promise<void> => {
      calls.push(input);
    },
    calls,
  };
}

// ── rephraseWithLLM — capture instrumentation ─────────────────────────────────

describe("rephraseWithLLM — capture instrumentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits one capture with callType=recon-rephrase on a successful rephrase", async () => {
    const client = makeAnthropicClient("click the submit button instead");
    const { fn, calls } = makeCaptureFn();

    const result = await rephraseWithLLM(
      client,
      "click the login button",
      ["#login-btn"],
      [],
      ["no observable effect"],
      fn
    );

    expect(result).toBe("click the submit button instead");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.callType).toBe(CALL_TYPE_RECON_REPHRASE);
    expect(calls[0]?.parsedOk).toBe(true);
    expect(calls[0]?.success).toBe(true);
  });

  it("sets model to the bare model name from config", async () => {
    const client = makeAnthropicClient("use the sign-in link at the top");
    const { fn, calls } = makeCaptureFn();

    await rephraseWithLLM(client, "click login", [], [], [], fn);

    expect(calls[0]?.model).toBe("claude-sonnet-4-6");
  });

  it("records parsedOk=false when the model replies IMPOSSIBLE", async () => {
    const client = makeAnthropicClient("IMPOSSIBLE");
    const { fn, calls } = makeCaptureFn();

    const result = await rephraseWithLLM(
      client,
      "click the login button",
      [],
      [],
      ["element not found"],
      fn
    );

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.callType).toBe(CALL_TYPE_RECON_REPHRASE);
    expect(calls[0]?.parsedOk).toBe(false);
    expect(calls[0]?.success).toBe(false);
  });

  it("records parsedOk=false when the model returns an empty string", async () => {
    const client = makeAnthropicClient("   ");
    const { fn, calls } = makeCaptureFn();

    const result = await rephraseWithLLM(client, "click the login button", [], [], [], fn);

    expect(result).toBeNull();
    expect(calls[0]?.parsedOk).toBe(false);
  });

  it("records parsedOk=false and does not throw when the API call throws", async () => {
    const client = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error("network error")),
      },
    } as unknown as Anthropic;
    const { fn, calls } = makeCaptureFn();

    const result = await rephraseWithLLM(client, "click the login button", [], [], [], fn);

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.parsedOk).toBe(false);
    expect(calls[0]?.responseContent).toBeNull();
  });

  it("captures input/output token counts from the response usage", async () => {
    const client = makeAnthropicClient("try the header link", 120, 7);
    const { fn, calls } = makeCaptureFn();

    await rephraseWithLLM(client, "click login", [], [], [], fn);

    expect(calls[0]?.inputTokens).toBe(120);
    expect(calls[0]?.outputTokens).toBe(7);
  });

  it("includes the callId as a non-empty string", async () => {
    const client = makeAnthropicClient("try the header nav link");
    const { fn, calls } = makeCaptureFn();

    await rephraseWithLLM(client, "click login", [], [], [], fn);

    expect(typeof calls[0]?.callId).toBe("string");
    expect((calls[0]?.callId ?? "").length).toBeGreaterThan(0);
  });
});
