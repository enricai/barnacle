/**
 * Unit tests for the NDJSON call-capture sink. All tests write to a temp
 * directory so no real `.barnacle/` directory is touched.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config", () => ({
  config: {
    telemetry: {
      callsNdjsonPath: ".barnacle/calls.ndjson",
      s3: {
        bucket: undefined,
      },
    },
  },
}));

vi.mock("@/lib/logging", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    errorWithStack: vi.fn(),
  }),
}));

import {
  captureLlmCall,
  classifyLlmCallFailure,
  type LlmCallSample,
  llmCallSampleSchema,
} from "@/lib/telemetry/call-capture";

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeInput(): Parameters<typeof captureLlmCall>[0] {
  return {
    callId: "call-abc-123",
    callType: "act",
    model: "anthropic/claude-sonnet-4-6",
    systemPrompt: "You are a browser automation agent.",
    userContent: "Click the login button.",
    responseContent: '{"success": true}',
    parsedOk: true,
    inputTokens: 42,
    outputTokens: 8,
    latencyMs: 312,
    success: true,
    errorMessage: null,
    failureKind: null,
  };
}

// ── test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;
let sinkPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "call-capture-test-"));
  sinkPath = path.join(tmpDir, "calls.ndjson");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ── captureLlmCall ────────────────────────────────────────────────────────────

describe("captureLlmCall", () => {
  it("appends exactly one line per call", async () => {
    await captureLlmCall(makeInput(), { sinkPath });

    const content = fs.readFileSync(sinkPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
  });

  it("appends two lines for two calls", async () => {
    await captureLlmCall(makeInput(), { sinkPath });
    await captureLlmCall({ ...makeInput(), callId: "call-def-456" }, { sinkPath });

    const content = fs.readFileSync(sinkPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
  });

  it("each line is valid JSON", async () => {
    await captureLlmCall(makeInput(), { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it("line contains all required fields and passes the Zod schema", async () => {
    await captureLlmCall(makeInput(), { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = JSON.parse(line) as LlmCallSample;
    const result = llmCallSampleSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it("carries the callType, model, parsedOk, and ts fields", async () => {
    const input = makeInput();
    await captureLlmCall(input, { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = JSON.parse(line) as LlmCallSample;
    expect(parsed.callType).toBe(input.callType);
    expect(parsed.model).toBe(input.model);
    expect(parsed.parsedOk).toBe(input.parsedOk);
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("carries the prompt and response content fields", async () => {
    const input = makeInput();
    await captureLlmCall(input, { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = JSON.parse(line) as LlmCallSample;
    expect(parsed.systemPrompt).toBe(input.systemPrompt);
    expect(parsed.userContent).toBe(input.userContent);
    expect(parsed.responseContent).toBe(input.responseContent);
  });

  it("line is terminated by a newline character", async () => {
    await captureLlmCall(makeInput(), { sinkPath });

    const content = fs.readFileSync(sinkPath, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("creates the sink directory if it does not exist", async () => {
    const nestedSink = path.join(tmpDir, "deep", "nested", "calls.ndjson");
    await captureLlmCall(makeInput(), { sinkPath: nestedSink });

    expect(fs.existsSync(nestedSink)).toBe(true);
  });

  it("accepts null for optional fields", async () => {
    const input = {
      ...makeInput(),
      systemPrompt: null,
      responseContent: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
    };
    await captureLlmCall(input, { sinkPath });

    const line = fs.readFileSync(sinkPath, "utf-8").trim();
    const parsed = JSON.parse(line) as LlmCallSample;
    expect(parsed.systemPrompt).toBeNull();
    expect(parsed.responseContent).toBeNull();
    expect(parsed.inputTokens).toBeNull();
    expect(parsed.outputTokens).toBeNull();
    expect(parsed.latencyMs).toBeNull();
  });
});

describe("classifyLlmCallFailure", () => {
  it("detects Anthropic billing exhaustion from the error message", () => {
    expect(classifyLlmCallFailure(new Error("Your credit balance is too low. Top up at..."))).toBe(
      "anthropic-billing"
    );
    expect(classifyLlmCallFailure(new Error("insufficient_quota for this account"))).toBe(
      "anthropic-billing"
    );
  });

  it("classifies status 402 + structured billing_error as anthropic-billing", () => {
    const err = Object.assign(new Error("Payment method declined"), {
      status: 402,
      type: "billing_error",
    });
    expect(classifyLlmCallFailure(err)).toBe("anthropic-billing");
  });

  it("classifies status 429 + structured rate_limit_error as anthropic-rate-limit", () => {
    const err = Object.assign(new Error("RPM exceeded"), {
      status: 429,
      type: "rate_limit_error",
    });
    expect(classifyLlmCallFailure(err)).toBe("anthropic-rate-limit");
  });

  it("classifies status 400 + invalid_request_error + quota message as anthropic-billing", () => {
    // The ACTUAL shape we observed on Saint Alphonsus jobs 6+7 — Anthropic
    // returns 400 + invalid_request_error for quota exhaustion, with the
    // distinguishing phrase only in the message.
    const responseBody =
      '{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-07-01."}}';
    const err = Object.assign(new Error(`400 ${responseBody}`), {
      statusCode: 400,
      responseBody,
    });
    expect(classifyLlmCallFailure(err)).toBe("anthropic-billing");
  });

  it("classifies status 400 + invalid_request_error + non-quota message as anthropic-other", () => {
    // The disambiguation case: same 400/invalid_request_error tuple, but
    // a genuinely bad request — should not trip the billing classifier.
    const responseBody =
      '{"type":"error","error":{"type":"invalid_request_error","message":"model: claude-fake-model not found"}}';
    const err = Object.assign(new Error(`400 ${responseBody}`), {
      statusCode: 400,
      responseBody,
    });
    expect(classifyLlmCallFailure(err)).toBe("anthropic-other");
  });

  it("extracts error.type from JSON embedded in err.message when no structured fields present", () => {
    // Vercel ai SDK default toString format: "<status> {json}" in the message.
    // No .statusCode, no .responseBody — just the message — but the embedded
    // JSON still resolves to the structural classification.
    const err = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits."}}'
    );
    expect(classifyLlmCallFailure(err)).toBe("anthropic-billing");
  });

  it("detects rate-limit errors by HTTP status or error name", () => {
    const rateErr = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      name: "RateLimitError",
    });
    expect(classifyLlmCallFailure(rateErr)).toBe("anthropic-rate-limit");
  });

  it("detects schema-validation failures by message content", () => {
    expect(
      classifyLlmCallFailure(new Error("structured-output enabled but parsed_output is null"))
    ).toBe("schema-validation-failed");
    expect(classifyLlmCallFailure(new Error("Zod parsing failed: missing field x"))).toBe(
      "schema-validation-failed"
    );
  });

  it("classifies generic Anthropic API errors with a numeric status as anthropic-other", () => {
    const apiErr = Object.assign(new Error("Internal server error"), { status: 500 });
    expect(classifyLlmCallFailure(apiErr)).toBe("anthropic-other");
  });

  it("falls back to exception-other for unmatched errors", () => {
    expect(classifyLlmCallFailure(new Error("DNS lookup timed out"))).toBe("exception-other");
    expect(classifyLlmCallFailure("plain string error")).toBe("exception-other");
  });
});
