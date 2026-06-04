/**
 * Unit tests for the LLM call-capture instrumentation in recon-browser.ts.
 * All tests stub the Anthropic SDK and inject a fake capture sink so no real
 * network calls or Steel sessions occur.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import {
  denormalizeStep,
  type NormalizedStep,
  persistReplannedFlow,
  type ReplanEvent,
  rephraseWithLLM,
} from "@/scripts/recon-browser";
import type { Logger } from "@/types/logging";

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

// ─── denormalizeStep + persistReplannedFlow ──────────────────────────────────

// The hoisted loggerStub is a typed-loose vi mock; persistReplannedFlow's
// param wants the full Logger interface. The cast is safe because the function
// only calls .info / .warn / .error, all of which the stub provides.
const testLogger = loggerStub as unknown as Logger;

describe("recon-browser/denormalizeStep", () => {
  it("returns bare string for default flags (required, non-upload)", () => {
    expect(denormalizeStep({ instruction: "Click Continue", optional: false, upload: false })).toBe(
      "Click Continue"
    );
  });

  it("emits object form with optional flag only when optional=true", () => {
    expect(denormalizeStep({ instruction: "Skip me", optional: true, upload: false })).toEqual({
      step: "Skip me",
      optional: true,
    });
  });

  it("emits object form with upload flag only when upload=true", () => {
    expect(
      denormalizeStep({ instruction: "Upload resume", optional: false, upload: true })
    ).toEqual({ step: "Upload resume", upload: true });
  });

  it("emits both flags when both are set (schema supports it)", () => {
    expect(denormalizeStep({ instruction: "Maybe upload", optional: true, upload: true })).toEqual({
      step: "Maybe upload",
      optional: true,
      upload: true,
    });
  });
});

describe("recon-browser/persistReplannedFlow", () => {
  let tmpDir: string;
  let flowPath: string;

  // Build a per-test tmp dir + clear the hoisted loggerStub. afterEach removes
  // the dir even when an assertion throws, so a failing test can't leak files
  // or carry mock-call state into the next one.
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-persist-"));
    flowPath = join(tmpDir, "recon-flow.json");
    loggerStub.info.mockClear();
    loggerStub.warn.mockClear();
    loggerStub.error.mockClear();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("backs up the ORIGINAL bytes verbatim (not re-serialized), then writes the new plan", () => {
    // Original file has idiosyncratic formatting: 4-space indent, trailing
    // whitespace, etc. Backup must preserve those bytes exactly.
    const originalBytes = '[\n    "Step A",\n    "Step B"\n]\n';
    writeFileSync(flowPath, originalBytes);

    const finalPlan: NormalizedStep[] = [
      { instruction: "Step A", optional: false, upload: false },
      { instruction: "Bridge X", optional: false, upload: false },
      { instruction: "Step B", optional: false, upload: false },
    ];
    const replanEvents: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "probe-absent",
        indexAtFailure: 1,
        failedInstruction: "Step B",
        replanSteps: [{ instruction: "Bridge X", optional: false, upload: false }],
        timestamp: "2026-06-03T20:00:00.000Z",
      },
    ];

    persistReplannedFlow({ flowFile: flowPath, finalPlan, replanEvents, logger: testLogger });

    // The backup sidecar should exist with the EXACT original bytes.
    const backupFiles = readdirSync(tmpDir).filter((f) => f.includes(".bak.json"));
    expect(backupFiles).toHaveLength(1);
    const backupContents = readFileSync(join(tmpDir, backupFiles[0]!), "utf8");
    expect(backupContents).toBe(originalBytes);

    // The flow.json now reflects the in-memory plan, 2-space indent + trailing newline.
    const newContents = readFileSync(flowPath, "utf8");
    expect(newContents).toBe(`[\n  "Step A",\n  "Bridge X",\n  "Step B"\n]\n`);
  });

  it("denormalizes optional/upload steps to object form in the written file", () => {
    writeFileSync(flowPath, '["Step A"]\n');

    const finalPlan: NormalizedStep[] = [
      { instruction: "Required", optional: false, upload: false },
      { instruction: "Maybe", optional: true, upload: false },
      { instruction: "File", optional: false, upload: true },
    ];
    const replanEvents: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "cascade-exhausted",
        indexAtFailure: 0,
        failedInstruction: "Step A",
        replanSteps: finalPlan,
        timestamp: "2026-06-03T20:00:00.000Z",
      },
    ];

    persistReplannedFlow({ flowFile: flowPath, finalPlan, replanEvents, logger: testLogger });

    const newContents = readFileSync(flowPath, "utf8");
    const parsed = JSON.parse(newContents) as unknown[];
    expect(parsed).toEqual([
      "Required",
      { step: "Maybe", optional: true },
      { step: "File", upload: true },
    ]);
  });

  it("prints a logger.info summary block describing each replan event", () => {
    writeFileSync(flowPath, '["Step A"]\n');

    const finalPlan: NormalizedStep[] = [{ instruction: "Bridge", optional: false, upload: false }];
    const replanEvents: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "probe-absent",
        indexAtFailure: 0,
        failedInstruction: "Step A",
        replanSteps: [{ instruction: "Bridge", optional: false, upload: false }],
        timestamp: "2026-06-03T20:00:00.000Z",
      },
    ];

    persistReplannedFlow({ flowFile: flowPath, finalPlan, replanEvents, logger: testLogger });

    const allOutput = loggerStub.info.mock.calls
      .map((args: unknown[]) => args.map(String).join(" "))
      .join("\n");
    expect(allOutput).toContain("flow.json updated");
    expect(allOutput).toContain("original backed up:");
    expect(allOutput).toContain("replan #1 (probe-absent)");
    expect(allOutput).toContain("failed: Step A");
    expect(allOutput).toContain("• Bridge");
  });

  it("preserves the object-shape on write-back when originalShape='object'", () => {
    // Start with the legacy bare-array bytes on disk; pass originalShape=object
    // + a pattern. The new file should be an object with steps[] + pattern,
    // not a bare array.
    writeFileSync(flowPath, '["Step A"]\n');
    const finalPlan: NormalizedStep[] = [{ instruction: "Step A", optional: false, upload: false }];
    const replanEvents: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "probe-absent",
        indexAtFailure: 0,
        failedInstruction: "Step A",
        replanSteps: finalPlan,
        timestamp: "2026-06-03T20:00:00.000Z",
      },
    ];

    persistReplannedFlow({
      flowFile: flowPath,
      finalPlan,
      replanEvents,
      logger: testLogger,
      originalShape: "object",
      submitEndpointPattern: "^https://example\\.com/api/submit$",
    });

    const newContents = readFileSync(flowPath, "utf8");
    const parsed = JSON.parse(newContents) as { steps: unknown[]; submitEndpointPattern: string };
    expect(parsed).toEqual({
      steps: ["Step A"],
      submitEndpointPattern: "^https://example\\.com/api/submit$",
    });
  });

  it("falls back to bare-array shape when originalShape is omitted (back-compat)", () => {
    writeFileSync(flowPath, '["X"]\n');
    const finalPlan: NormalizedStep[] = [{ instruction: "X", optional: false, upload: false }];
    const replanEvents: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "probe-absent",
        indexAtFailure: 0,
        failedInstruction: "X",
        replanSteps: finalPlan,
        timestamp: "2026-06-03T20:00:00.000Z",
      },
    ];

    persistReplannedFlow({ flowFile: flowPath, finalPlan, replanEvents, logger: testLogger });

    const newContents = readFileSync(flowPath, "utf8");
    expect(JSON.parse(newContents)).toEqual(["X"]);
  });

  it("omits submitEndpointPattern from object-shape output when pattern is null", () => {
    writeFileSync(flowPath, '{"steps":["X"]}\n');
    const finalPlan: NormalizedStep[] = [{ instruction: "X", optional: false, upload: false }];
    const replanEvents: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "probe-absent",
        indexAtFailure: 0,
        failedInstruction: "X",
        replanSteps: finalPlan,
        timestamp: "2026-06-03T20:00:00.000Z",
      },
    ];

    persistReplannedFlow({
      flowFile: flowPath,
      finalPlan,
      replanEvents,
      logger: testLogger,
      originalShape: "object",
      submitEndpointPattern: null,
    });

    const parsed = JSON.parse(readFileSync(flowPath, "utf8"));
    expect(parsed).toEqual({ steps: ["X"] });
    expect(parsed.submitEndpointPattern).toBeUndefined();
  });

  it("skips write-back gracefully when the original file disappears mid-run", () => {
    // No flowPath written — readFileSync should fail. persistReplannedFlow
    // logs an error and returns without writing the new flow.json. This
    // protects the user's data when something external removed the file.
    const finalPlan: NormalizedStep[] = [
      { instruction: "Whatever", optional: false, upload: false },
    ];
    const replanEvents: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "probe-absent",
        indexAtFailure: 0,
        failedInstruction: "X",
        replanSteps: finalPlan,
        timestamp: "2026-06-03T20:00:00.000Z",
      },
    ];

    expect(() =>
      persistReplannedFlow({ flowFile: flowPath, finalPlan, replanEvents, logger: testLogger })
    ).not.toThrow();
    expect(existsSync(flowPath)).toBe(false);
    expect(loggerStub.error).toHaveBeenCalled();
  });
});
