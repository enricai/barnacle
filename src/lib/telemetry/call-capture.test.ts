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
