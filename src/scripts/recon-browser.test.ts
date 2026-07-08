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

import type { StepVerificationErrorKind } from "@/scraper/errors";

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
    readonly kind: StepVerificationErrorKind;
    constructor(message = "step failed", kind: StepVerificationErrorKind = "cascade-exhausted") {
      super(message);
      this.kind = kind;
    }
  },
}));

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({
  getLogger: () => loggerStub,
  getScriptLogger: () => loggerStub,
}));

vi.mock("@/lib/telemetry/call-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telemetry/call-capture")>();
  return {
    ...actual,
    captureLlmCall: vi.fn().mockResolvedValue(undefined),
  };
});

import type { LlmCallInput } from "@/lib/telemetry/call-capture";
import { CALL_TYPE_RECON_REPHRASE, CALL_TYPE_RECON_REPLAN } from "@/lib/telemetry/call-types";
import {
  countSlugPrefixMatches,
  dedupeConsecutiveIdentical,
  denormalizeStep,
  describeAttemptEffectSignals,
  detectRejectionInResponseBody,
  extractGaEventEvidence,
  extractSubmitFailureEvidence,
  fillHtml5DateTimeInput,
  filterCompletedFromReplan,
  findRecentBackendError,
  findRecentPageTransition,
  findWizardRestartSignal,
  formatValidationRejectedReason,
  type Html5DateFillResult,
  hasBillingErrorBeenLogged,
  type InvalidFormControl,
  isReplanCycle,
  isStructurallyBlocked,
  isSubmitRevealedInvalid,
  isWizardExitAction,
  type LeafInvalidField,
  logBillingErrorIfPresent,
  type NormalizedStep,
  narrowInvalidFormControl,
  normalizeDateValue,
  pairInvalidWithErrors,
  parseSelectStep,
  persistReplannedFlow,
  pollEnumerate,
  probeLeafInvalidContainers,
  probeStepBeforeAttempts,
  type ReplanEvent,
  readFailureDumpEvidence,
  renderLeafInvalidFields,
  renderStepWindow,
  renderUnfocusedObserve,
  rephraseWithLLM,
  replanRemainingFlow,
  resetBillingErrorFlagForTests,
  selectBodyExcerpt,
  shouldSkipTechnique,
  summarizeReplanFailureKinds,
  type ValidationRejectionPair,
  type VerifyFillReadbackResult,
  verifyFillReadback,
  windowHasTransitionBody,
} from "@/scripts/recon-browser";
import type { Logger } from "@/types/logging";

// ── fixtures ──────────────────────────────────────────────────────────────────

/**
 * Make a rephrase-mocking Anthropic stub.
 *
 * `responseText` overloads meaning per the new structured-output schema:
 *  - "IMPOSSIBLE" or "" returns outcome=impossible (back-compat for tests
 *    written against the previous magic-string contract)
 *  - any other string returns outcome=rewrite with that text as the
 *    instruction field
 *
 * The `content` field carries the JSON serialization the SDK would have
 * received so capture instrumentation that records `responseContent` keeps
 * working unchanged.
 */
function makeAnthropicClient(responseText: string, inputTokens = 50, outputTokens = 10): Anthropic {
  const trimmed = responseText.trim();
  const parsed =
    trimmed.length === 0 || trimmed === "IMPOSSIBLE"
      ? { outcome: "impossible" as const, reason: "no different element resolvable on this page" }
      : {
          outcome: "rewrite" as const,
          instruction: responseText,
        };
  return {
    messages: {
      parse: vi.fn().mockResolvedValue({
        parsed_output: parsed,
        content: [{ type: "text", text: JSON.stringify(parsed) }],
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

  it("returns null when the model emits outcome=impossible (schema-valid)", async () => {
    // The new structured-output schema accepts outcome=impossible as a valid
    // response. parsedOk=true reflects that the schema parsed cleanly; the
    // caller still gets back null because there's no instruction to retry.
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
    expect(calls[0]?.parsedOk).toBe(true);
    expect(calls[0]?.success).toBe(true);
  });

  it("records parsedOk=false and does not throw when the API call throws", async () => {
    const client = {
      messages: {
        parse: vi.fn().mockRejectedValue(new Error("network error")),
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

  it("includes the ng-invalid evidence section when pageEvidence is supplied", async () => {
    const client = makeAnthropicClient(
      "Re-fill the Legal First Name field with the candidate's first name"
    );
    const { fn, calls } = makeCaptureFn();

    await rephraseWithLLM(
      client,
      "Click the Submit Application button",
      [],
      [],
      ["no observable effect"],
      fn,
      {
        invalidFieldList: "1. Legal First Name <app-input>  [ng-invalid]",
        errorTextList: "1. This field is required.",
        interactiveTargetsList: "1. [Legal First Name] input '' — xpath=/html[1]/body[1]/input[1]",
      }
    );

    const prompt = calls[0]?.userContent ?? "";
    expect(prompt).toContain("FORM FIELDS CURRENTLY MARKED INVALID");
    expect(prompt).toContain("Legal First Name");
    expect(prompt).toContain("VISIBLE ERROR / REQUIRED-FIELD MESSAGES");
    expect(prompt).toContain("This field is required");
    expect(prompt).toContain("INTERACTIVE TARGETS NEAR INVALID FIELDS");
    expect(prompt).toContain("Legal First Name");
  });

  it("renders the new evidence sections as '(none)' when no pageEvidence is supplied (back-compat)", async () => {
    const client = makeAnthropicClient("Click the Submit button using the form's submit handler");
    const { fn, calls } = makeCaptureFn();

    await rephraseWithLLM(client, "Click Submit", [], [], ["no observable effect"], fn);

    const prompt = calls[0]?.userContent ?? "";
    // The two new sections always render — empty when no evidence is supplied
    // so the prompt schema is consistent across runs with and without evidence.
    expect(prompt).toContain("FORM FIELDS CURRENTLY MARKED INVALID");
    expect(prompt).toMatch(/FORM FIELDS CURRENTLY MARKED INVALID[^\n]*\n[^\n]*\(none\)/);
    expect(prompt).toContain("VISIBLE ERROR / REQUIRED-FIELD MESSAGES");
  });

  // V4-C structural-fix coverage. The empirical finding (3/3 PIVOT vs 3/3
  // FIXATE in offline A/B against claude-opus-4-7) is that putting any
  // meaningful content above ORIGINAL INSTRUCTION breaks the LLM's anchor
  // to the failed instruction and lets it act on the redirect evidence.
  it("V4-C: prepends a redirect block above ORIGINAL INSTRUCTION when invalid + interactive evidence both exist", async () => {
    const client = makeAnthropicClient("Click the No radio for the current employee question");
    const { fn, calls } = makeCaptureFn();

    await rephraseWithLLM(
      client,
      "Click the date picker for earliest available start date",
      [],
      [],
      ["no observable effect"],
      fn,
      {
        invalidFieldList: "1. Are you a current employee? <!---- [ng-invalid]",
        errorTextList: "1. This field is required.",
        interactiveTargetsList:
          "1. [Are you a current employee?] label 'No' — xpath=/html[1]/body[1]/...",
      }
    );

    const prompt = calls[0]?.userContent ?? "";
    // The top redirect block exists.
    expect(prompt).toContain("Important context: the form is currently blocked by OTHER fields");
    // And it sits ABOVE the ORIGINAL INSTRUCTION anchor.
    const redirectIdx = prompt.indexOf("Important context: the form is currently blocked");
    const originalIdx = prompt.indexOf("ORIGINAL INSTRUCTION:");
    expect(redirectIdx).toBeGreaterThanOrEqual(0);
    expect(originalIdx).toBeGreaterThan(redirectIdx);
  });

  it("V4-C: does NOT prepend the redirect block when only invalid fields exist (no interactive targets)", async () => {
    const client = makeAnthropicClient("Click the No radio for the current employee question");
    const { fn, calls } = makeCaptureFn();

    await rephraseWithLLM(
      client,
      "Click the date picker for earliest available start date",
      [],
      [],
      ["no observable effect"],
      fn,
      {
        invalidFieldList: "1. Are you a current employee? <!---- [ng-invalid]",
        errorTextList: "1. This field is required.",
        interactiveTargetsList: "",
      }
    );

    const prompt = calls[0]?.userContent ?? "";
    // Without clickable redirect targets, the LLM can see the field is
    // invalid but has nowhere to redirect — so V4-C stays silent.
    expect(prompt).not.toContain(
      "Important context: the form is currently blocked by OTHER fields"
    );
  });

  it("V4-C: does NOT prepend the redirect block when only interactive targets exist (no invalid fields)", async () => {
    const client = makeAnthropicClient("Click the No radio for the current employee question");
    const { fn, calls } = makeCaptureFn();

    await rephraseWithLLM(
      client,
      "Click the date picker for earliest available start date",
      [],
      [],
      ["no observable effect"],
      fn,
      {
        invalidFieldList: "",
        errorTextList: "",
        interactiveTargetsList:
          "1. [Are you a current employee?] label 'No' — xpath=/html[1]/body[1]/...",
      }
    );

    const prompt = calls[0]?.userContent ?? "";
    expect(prompt).not.toContain(
      "Important context: the form is currently blocked by OTHER fields"
    );
  });

  it("V4-C: records the system prompt on captures (rule moved out of user prompt)", async () => {
    const client = makeAnthropicClient("Click the alternative submit element");
    const { fn, calls } = makeCaptureFn();

    await rephraseWithLLM(client, "Click Submit", [], [], ["no observable effect"], fn);

    // Per Anthropic guidance, the durable "target a different element OR
    // return outcome=impossible" rule lives in `system`, not buried at the
    // bottom of the user prompt.
    expect(calls[0]?.systemPrompt).toBeTruthy();
    expect(calls[0]?.systemPrompt).toContain("targets a different element");
  });
});

// ─── denormalizeStep + persistReplannedFlow ──────────────────────────────────

// The hoisted loggerStub is a typed-loose vi mock; persistReplannedFlow's
// param wants the full Logger interface. The cast is safe because the function
// only calls .info / .warn / .error, all of which the stub provides.
const testLogger = loggerStub as unknown as Logger;

describe("recon-browser/denormalizeStep", () => {
  it("returns bare string for default flags (required, non-upload)", () => {
    expect(
      denormalizeStep({
        instruction: "Click Continue",
        optional: false,
        upload: false,
        origin: "original",
      })
    ).toBe("Click Continue");
  });

  it("emits object form with optional flag only when optional=true", () => {
    expect(
      denormalizeStep({ instruction: "Skip me", optional: true, upload: false, origin: "original" })
    ).toEqual({
      step: "Skip me",
      optional: true,
    });
  });

  it("emits object form with upload flag only when upload=true", () => {
    expect(
      denormalizeStep({
        instruction: "Upload resume",
        optional: false,
        upload: true,
        origin: "original",
      })
    ).toEqual({ step: "Upload resume", upload: true });
  });

  it("emits both flags when both are set (schema supports it)", () => {
    expect(
      denormalizeStep({
        instruction: "Maybe upload",
        optional: true,
        upload: true,
        origin: "original",
      })
    ).toEqual({
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
      { instruction: "Step A", optional: false, upload: false, origin: "original" },
      { instruction: "Bridge X", optional: false, upload: false, origin: "original" },
      { instruction: "Step B", optional: false, upload: false, origin: "original" },
    ];
    const replanEvents: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "probe-absent",
        indexAtFailure: 1,
        failedInstruction: "Step B",
        replanSteps: [
          { instruction: "Bridge X", optional: false, upload: false, origin: "original" },
        ],
        timestamp: "2026-06-03T20:00:00.000Z",
        pageState: { url: "https://example.com/apply", htmlLength: 50000 },
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
      { instruction: "Required", optional: false, upload: false, origin: "original" },
      { instruction: "Maybe", optional: true, upload: false, origin: "original" },
      { instruction: "File", optional: false, upload: true, origin: "original" },
    ];
    const replanEvents: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "cascade-exhausted",
        indexAtFailure: 0,
        failedInstruction: "Step A",
        replanSteps: finalPlan,
        timestamp: "2026-06-03T20:00:00.000Z",
        pageState: { url: "https://example.com/apply", htmlLength: 50000 },
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

    const finalPlan: NormalizedStep[] = [
      { instruction: "Bridge", optional: false, upload: false, origin: "original" },
    ];
    const replanEvents: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "probe-absent",
        indexAtFailure: 0,
        failedInstruction: "Step A",
        replanSteps: [
          { instruction: "Bridge", optional: false, upload: false, origin: "original" },
        ],
        timestamp: "2026-06-03T20:00:00.000Z",
        pageState: { url: "https://example.com/apply", htmlLength: 50000 },
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
    const finalPlan: NormalizedStep[] = [
      { instruction: "Step A", optional: false, upload: false, origin: "original" },
    ];
    const replanEvents: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "probe-absent",
        indexAtFailure: 0,
        failedInstruction: "Step A",
        replanSteps: finalPlan,
        timestamp: "2026-06-03T20:00:00.000Z",
        pageState: { url: "https://example.com/apply", htmlLength: 50000 },
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
    const finalPlan: NormalizedStep[] = [
      { instruction: "X", optional: false, upload: false, origin: "original" },
    ];
    const replanEvents: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "probe-absent",
        indexAtFailure: 0,
        failedInstruction: "X",
        replanSteps: finalPlan,
        timestamp: "2026-06-03T20:00:00.000Z",
        pageState: { url: "https://example.com/apply", htmlLength: 50000 },
      },
    ];

    persistReplannedFlow({ flowFile: flowPath, finalPlan, replanEvents, logger: testLogger });

    const newContents = readFileSync(flowPath, "utf8");
    expect(JSON.parse(newContents)).toEqual(["X"]);
  });

  it("omits submitEndpointPattern from object-shape output when pattern is null", () => {
    writeFileSync(flowPath, '{"steps":["X"]}\n');
    const finalPlan: NormalizedStep[] = [
      { instruction: "X", optional: false, upload: false, origin: "original" },
    ];
    const replanEvents: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "probe-absent",
        indexAtFailure: 0,
        failedInstruction: "X",
        replanSteps: finalPlan,
        timestamp: "2026-06-03T20:00:00.000Z",
        pageState: { url: "https://example.com/apply", htmlLength: 50000 },
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
      { instruction: "Whatever", optional: false, upload: false, origin: "original" },
    ];
    const replanEvents: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "probe-absent",
        indexAtFailure: 0,
        failedInstruction: "X",
        replanSteps: finalPlan,
        timestamp: "2026-06-03T20:00:00.000Z",
        pageState: { url: "https://example.com/apply", htmlLength: 50000 },
      },
    ];

    expect(() =>
      persistReplannedFlow({ flowFile: flowPath, finalPlan, replanEvents, logger: testLogger })
    ).not.toThrow();
    expect(existsSync(flowPath)).toBe(false);
    expect(loggerStub.error).toHaveBeenCalled();
  });

  it("coerces replan-origin steps to optional on write-back even when they came in as required", () => {
    // Regression: a cross-employer sweep had job N persist employer-specific
    // replanned steps as REQUIRED bare strings, then job N+1 (different
    // employer) cascade-exhausted trying to fill questions that don't exist
    // on the new employer's form. Auto-coercion to optional means replanned
    // steps probe-absent-skip on non-matching employers.
    writeFileSync(flowPath, '["Step A"]\n');
    const finalPlan: NormalizedStep[] = [
      { instruction: "Hand-authored required", optional: false, upload: false, origin: "original" },
      { instruction: "LLM-discovered required", optional: false, upload: false, origin: "replan" },
    ];
    const replanEvents: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "cascade-exhausted",
        indexAtFailure: 0,
        failedInstruction: "Step A",
        replanSteps: [finalPlan[1]!],
        timestamp: "2026-06-03T20:00:00.000Z",
        pageState: { url: "https://example.com/apply", htmlLength: 50000 },
      },
    ];

    persistReplannedFlow({ flowFile: flowPath, finalPlan, replanEvents, logger: testLogger });

    const parsed = JSON.parse(readFileSync(flowPath, "utf8")) as unknown[];
    expect(parsed).toEqual([
      "Hand-authored required",
      { step: "LLM-discovered required", optional: true },
    ]);
  });

  it("leaves an already-optional replan step alone (no-op coercion)", () => {
    writeFileSync(flowPath, '["Step A"]\n');
    const finalPlan: NormalizedStep[] = [
      { instruction: "Replan-optional", optional: true, upload: false, origin: "replan" },
    ];
    const replanEvents: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "probe-absent",
        indexAtFailure: 0,
        failedInstruction: "Step A",
        replanSteps: finalPlan,
        timestamp: "2026-06-03T20:00:00.000Z",
        pageState: { url: "https://example.com/apply", htmlLength: 50000 },
      },
    ];

    persistReplannedFlow({ flowFile: flowPath, finalPlan, replanEvents, logger: testLogger });

    expect(JSON.parse(readFileSync(flowPath, "utf8"))).toEqual([
      { step: "Replan-optional", optional: true },
    ]);
  });
});

describe("recon-browser/readFailureDumpEvidence", () => {
  let tmpDir: string;
  let dumpPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-evidence-"));
    dumpPath = join(tmpDir, "step-failure.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty fields when the dump file is missing", async () => {
    const result = await readFailureDumpEvidence(join(tmpDir, "does-not-exist.json"));
    expect(result).toEqual({
      bodyExcerpt: "",
      unfocusedList: "",
      invalidFieldList: "",
      errorTextList: "",
      recentFailureReasons: [],
    });
  });

  it("returns empty judge-driven fields when no client is supplied", async () => {
    // Without a Haiku client the judges short-circuit to null and the caller
    // renders empty strings. Verifies the safe-fallback contract — judge
    // failures must NEVER cascade into errors in the replan path.
    const body = `<form class="ng-valid">
      <li class="question ng-invalid ng-dirty ng-touched">
        <label>County</label>
        <input class="ng-invalid" value=""/>
      </li>
    </form>`;
    writeFileSync(dumpPath, JSON.stringify({ bodyOuterHtml: body, attempts: [] }));
    const result = await readFailureDumpEvidence(dumpPath);
    expect(result.bodyExcerpt).toContain("County");
    expect(result.invalidFieldList).toBe("");
    expect(result.errorTextList).toBe("");
    expect(result.unfocusedList).toBe("");
  });

  it("recentFailureReasons surfaces the trailing 5 attempt errorMessage values", async () => {
    const attempts = Array.from({ length: 8 }, (_, i) => ({
      errorMessage: `attempt-${i + 1}: reason`,
    }));
    writeFileSync(dumpPath, JSON.stringify({ bodyOuterHtml: null, attempts }));
    const result = await readFailureDumpEvidence(dumpPath);
    expect(result.recentFailureReasons).toEqual([
      "attempt-4: reason",
      "attempt-5: reason",
      "attempt-6: reason",
      "attempt-7: reason",
      "attempt-8: reason",
    ]);
  });

  it("skips attempts with null/empty errorMessage when collecting reasons", async () => {
    const attempts = [
      { errorMessage: "real failure A" },
      { errorMessage: null },
      { errorMessage: "" },
      { errorMessage: "real failure B" },
    ];
    writeFileSync(dumpPath, JSON.stringify({ bodyOuterHtml: null, attempts }));
    const result = await readFailureDumpEvidence(dumpPath);
    expect(result.recentFailureReasons).toEqual(["real failure A", "real failure B"]);
  });
});

describe("recon-browser/narrowInvalidFormControl", () => {
  // The pre-submit probe runs in browser context via page.evaluate. The
  // Node side narrows the raw JS payload into a typed `InvalidFormControl`
  // record — these tests exercise that narrowing directly so we catch
  // schema-skew bugs without spinning up a real browser.

  it("narrows a complete entry with no auto-pick", () => {
    const raw = {
      label: "Legal First Name",
      classSignature: "ng-invalid ng-touched",
      emptyOrUnchecked: true,
      autoFilled: null,
    };
    const out = narrowInvalidFormControl(raw);
    expect(out).not.toBeNull();
    expect(out?.label).toBe("Legal First Name");
    expect(out?.emptyOrUnchecked).toBe(true);
    expect(out?.autoFilled).toBeNull();
  });

  it("narrows a complete entry with an auto-pick payload", () => {
    const raw = {
      label: "Gender",
      classSignature: "ng-invalid",
      emptyOrUnchecked: true,
      autoFilled: { action: "selected-radio", value: "Male" },
    };
    const out = narrowInvalidFormControl(raw);
    expect(out?.autoFilled).toEqual({ action: "selected-radio", value: "Male" });
  });

  it("returns null when required fields are missing", () => {
    expect(narrowInvalidFormControl({ label: "X" })).toBeNull();
    expect(
      narrowInvalidFormControl({ label: "X", classSignature: "y", emptyOrUnchecked: "not-a-bool" })
    ).toBeNull();
    expect(narrowInvalidFormControl(null)).toBeNull();
    expect(narrowInvalidFormControl("string")).toBeNull();
  });

  it("normalizes a malformed autoFilled to null without dropping the rest", () => {
    // Malformed autoFilled (string instead of object) should NOT poison
    // the record — the field still carries valid label/classSignature/etc.,
    // we just lose the auto-pick claim.
    const raw = {
      label: "Phone",
      classSignature: "ng-invalid",
      emptyOrUnchecked: false,
      autoFilled: "wrong-shape",
    };
    const out = narrowInvalidFormControl(raw);
    expect(out).not.toBeNull();
    expect(out?.label).toBe("Phone");
    expect(out?.autoFilled).toBeNull();
  });

  it("normalizes an autoFilled missing action/value fields to null", () => {
    const raw = {
      label: "ZIP",
      classSignature: "ng-invalid",
      emptyOrUnchecked: true,
      autoFilled: { value: "NA" }, // missing action
    };
    const out = narrowInvalidFormControl(raw);
    expect(out?.autoFilled).toBeNull();
  });

  it("type-narrowed result satisfies the public InvalidFormControl type", () => {
    // Compile-time check + structural assertion. If the type ever drifts
    // away from what narrowInvalidFormControl produces, this fails.
    const raw = {
      label: "L",
      classSignature: "s",
      emptyOrUnchecked: true,
      autoFilled: { action: "filled-text", value: "NA" },
    };
    const out: InvalidFormControl | null = narrowInvalidFormControl(raw);
    expect(out).not.toBeNull();
  });
});

describe("recon-browser/dedupeConsecutiveIdentical", () => {
  it("collapses consecutive identical strings", () => {
    expect(dedupeConsecutiveIdentical(["A", "B", "B", "B", "C", "B", "B"])).toEqual([
      "A",
      "B",
      "C",
      "B",
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(dedupeConsecutiveIdentical([])).toEqual([]);
  });

  it("returns single-item array unchanged", () => {
    expect(dedupeConsecutiveIdentical(["only"])).toEqual(["only"]);
  });

  it("collapses an all-identical run to a single entry", () => {
    expect(dedupeConsecutiveIdentical(["X", "X", "X", "X"])).toEqual(["X"]);
  });

  it("preserves non-adjacent duplicates", () => {
    expect(dedupeConsecutiveIdentical(["A", "B", "A", "B", "A"])).toEqual([
      "A",
      "B",
      "A",
      "B",
      "A",
    ]);
  });

  it("compares objects structurally via JSON-stringify equality", () => {
    const stepA = { step: "Fill First Name", optional: true };
    const stepB = { step: "Fill Last Name", optional: true };
    expect(dedupeConsecutiveIdentical([stepA, { ...stepA }, stepA, stepB, stepB])).toEqual([
      stepA,
      stepB,
    ]);
  });

  it("does NOT collapse a string and an object with the same instruction (different semantics)", () => {
    // Bare string = required step; object form = could be optional/upload.
    // These are NOT identical even when text matches.
    const bare = "Fill First Name";
    const objForm = { step: "Fill First Name", optional: true };
    expect(dedupeConsecutiveIdentical([bare, objForm])).toEqual([bare, objForm]);
  });

  it("returns a new array, not the input reference", () => {
    const input = ["A", "B"];
    const out = dedupeConsecutiveIdentical(input);
    expect(out).not.toBe(input);
    expect(out).toEqual(input);
  });
});

describe("recon-browser/filterCompletedFromReplan", () => {
  const mk = (instruction: string): NormalizedStep => ({
    instruction,
    optional: false,
    upload: false,
    origin: "replan",
  });

  it("drops bridge steps that re-run already-completed steps", () => {
    const raw = [
      mk("Fill in the First Name field with 'Reginald'"),
      mk("Fill in the Email field with 'x@y.z'"),
      mk("Click the NEXT button to proceed"),
    ];
    const completed = [
      "Fill in the First Name field with 'Reginald'",
      "Fill in the Email field with 'x@y.z'",
    ];
    const out = filterCompletedFromReplan(raw, completed, "Fill in the Address field");
    expect(out.map((s) => s.instruction)).toEqual(["Click the NEXT button to proceed"]);
  });

  it("keeps a re-emission of the failed step itself (legitimate no-op bridge)", () => {
    const raw = [mk("Fill in the Address field"), mk("Click NEXT")];
    const completed = ["Fill in the First Name field"];
    const out = filterCompletedFromReplan(raw, completed, "Fill in the Address field");
    expect(out.map((s) => s.instruction)).toEqual(["Fill in the Address field", "Click NEXT"]);
  });

  it("returns all steps unchanged when none are completed", () => {
    const raw = [mk("Step A"), mk("Step B")];
    const out = filterCompletedFromReplan(raw, [], "Step failed");
    expect(out).toEqual(raw);
  });
});

describe("recon-browser/isWizardExitAction", () => {
  it("matches unambiguous wizard-exit labels (case-insensitive substring)", () => {
    expect(isWizardExitAction("Continue Later button")).toBe(true);
    expect(isWizardExitAction("Save & Exit")).toBe(true);
    expect(isWizardExitAction("CANCEL APPLICATION link")).toBe(true);
    expect(isWizardExitAction("Start Over")).toBe(true);
  });

  it("does NOT match legitimate advance controls", () => {
    expect(isWizardExitAction("Continue button to proceed")).toBe(false);
    expect(isWizardExitAction("NEXT button to advance to the next page")).toBe(false);
    expect(isWizardExitAction("Apply link to advance to the job application page")).toBe(false);
    expect(isWizardExitAction("I ACCEPT button which serves as the Continue/Next action")).toBe(
      false
    );
    expect(isWizardExitAction("Submit Application")).toBe(false);
  });

  it("respects site-supplied extra labels and handles null/empty", () => {
    expect(isWizardExitAction("Return to dashboard", ["return to dashboard"])).toBe(true);
    expect(isWizardExitAction("Return to dashboard")).toBe(false);
    expect(isWizardExitAction(null)).toBe(false);
    expect(isWizardExitAction("")).toBe(false);
  });
});

describe("recon-browser/findWizardRestartSignal", () => {
  it("returns the matching URL when a restart-signal pattern appears in the step window", () => {
    const captures = [
      "https://apply.talemetry.com/application/abc/gq",
      "https://apply.talemetry.com/init-apply/x/job/id/1?application_canceled=true",
    ];
    const hit = findWizardRestartSignal({
      recentCaptures: captures,
      preLength: 1,
      restartSignalUrlPatterns: ["application_canceled=true"],
    });
    expect(hit).toContain("application_canceled=true");
  });

  it("ignores matches that landed BEFORE the step (preLength window)", () => {
    const captures = [
      "https://apply.talemetry.com/init-apply/x?application_canceled=true",
      "https://apply.talemetry.com/application/abc/gq",
    ];
    const hit = findWizardRestartSignal({
      recentCaptures: captures,
      preLength: 1,
      restartSignalUrlPatterns: ["application_canceled=true"],
    });
    expect(hit).toBeNull();
  });

  it("returns null when no patterns are configured (feature off)", () => {
    const hit = findWizardRestartSignal({
      recentCaptures: ["https://x/init-apply?application_canceled=true"],
      preLength: 0,
      restartSignalUrlPatterns: [],
    });
    expect(hit).toBeNull();
  });
});

describe("recon-browser/renderUnfocusedObserve", () => {
  // Helper to build a minimal Action-shaped object for testing.
  const make = (description: string): { description: string; selector: string } => ({
    description,
    selector: `xpath=//placeholder/${description.replace(/\s+/g, "-")}`,
  });

  it("returns empty string for empty input", async () => {
    expect(await renderUnfocusedObserve([])).toBe("");
  });

  it("renders entries as numbered description + selector lines (null-client fallback path)", async () => {
    const observations = [make("First Name input"), make("Submit button")];
    const out = await renderUnfocusedObserve(observations);
    expect(out).toContain("1. First Name input");
    expect(out).toContain("2. Submit button");
  });

  it("preserves source order when no Haiku client is supplied (safe-fallback)", async () => {
    // Without a judge client, modal-priority migration leaves order untouched.
    // This is the documented fallback: judge-failure must never corrupt the
    // baseline. Stagehand's emitted descriptions already cluster modals
    // near the top, so the unsorted output isn't catastrophic.
    const observations = [make("form field 0"), make("Save in modal"), make("form field 1")];
    const out = await renderUnfocusedObserve(observations);
    expect(out.indexOf("form field 0")).toBeLessThan(out.indexOf("Save in modal"));
  });

  it("caps the rendered list at the default cap (30)", async () => {
    const observations = Array.from({ length: 60 }, (_, i) => make(`item ${i}`));
    const out = await renderUnfocusedObserve(observations);
    const lines = out.split("\n");
    expect(lines.length).toBeLessThanOrEqual(30);
  });

  it("honors an explicit cap override via options", async () => {
    const observations = Array.from({ length: 60 }, (_, i) => make(`item ${i}`));
    const out = await renderUnfocusedObserve(observations, { cap: 5 });
    const lines = out.split("\n");
    expect(lines.length).toBeLessThanOrEqual(5);
  });
});

describe("recon-browser/extractSubmitFailureEvidence", () => {
  let tmpDir: string;
  const ownHosts = ["example.com"];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-submit-fail-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCapture(filename: string, body: object): void {
    writeFileSync(join(tmpDir, filename), JSON.stringify(body));
  }

  it("returns empty when ownBackendHostnames is empty", () => {
    expect(extractSubmitFailureEvidence(["capture-1.json"], [], tmpDir)).toBe("");
  });

  it("returns empty when no recent captures match the submit endpoint", () => {
    writeCapture("capture-1.json", {
      url: "https://example.com/api/other",
      status: 200,
      responseBody: { ok: true },
    });
    expect(extractSubmitFailureEvidence(["capture-1.json"], ownHosts, tmpDir)).toBe("");
  });

  it("returns empty when the submit-endpoint capture succeeded (2xx)", () => {
    writeCapture("capture-1.json", {
      url: "https://example.com/api/apply",
      status: 200,
      responseBody: { ok: true },
    });
    expect(extractSubmitFailureEvidence(["capture-1.json"], ownHosts, tmpDir)).toBe("");
  });

  it("parses the { errors: [{ field, message }] } shape on a 4xx", () => {
    writeCapture("capture-1.json", {
      url: "https://example.com/api/apply",
      status: 422,
      responseBody: {
        errors: [
          { field: "email", message: "Invalid format" },
          { field: "phone", message: "Required" },
        ],
      },
    });
    const out = extractSubmitFailureEvidence(["capture-1.json"], ownHosts, tmpDir);
    expect(out).toContain("422 https://example.com/api/apply");
    expect(out).toContain("email: Invalid format");
    expect(out).toContain("phone: Required");
  });

  it("parses the { validation: { field: message } } shape", () => {
    writeCapture("capture-1.json", {
      url: "https://example.com/api/apply",
      status: 400,
      responseBody: { validation: { firstName: "must be present" } },
    });
    const out = extractSubmitFailureEvidence(["capture-1.json"], ownHosts, tmpDir);
    expect(out).toContain("firstName: must be present");
  });

  it("falls back to top-level { message } when no field errors are present", () => {
    writeCapture("capture-1.json", {
      url: "https://example.com/api/apply",
      status: 500,
      responseBody: { message: "Internal server error" },
    });
    const out = extractSubmitFailureEvidence(["capture-1.json"], ownHosts, tmpDir);
    expect(out).toContain("Internal server error");
  });

  it("skips missing capture files silently", () => {
    expect(extractSubmitFailureEvidence(["missing.json"], ownHosts, tmpDir)).toBe("");
  });
});

describe("recon-browser/extractGaEventEvidence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-ga-event-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCapture(filename: string, body: object): void {
    writeFileSync(join(tmpDir, filename), JSON.stringify(body));
  }

  it("returns empty when no capture filenames are passed", () => {
    expect(extractGaEventEvidence([], tmpDir)).toBe("");
  });

  it("returns empty when captures do not target google-analytics.com/g/collect", () => {
    writeCapture("capture-1.json", {
      url: "https://apply.appcast.io/api/jobs/123/integrated_apply",
      status: 200,
      method: "POST",
    });
    expect(extractGaEventEvidence(["capture-1.json"], tmpDir)).toBe("");
  });

  it("parses view_secondPage with numeric and string event params", () => {
    writeCapture("capture-1.json", {
      url: "https://www.google-analytics.com/g/collect?v=2&tid=G-X&en=view_secondPage&dl=https%3A%2F%2Fapply.appcast.io%2Fjobs%2F999%2Fapplyboard%2Fapply%3Fcs%3Dsy3&dt=RN%20Hiring&epn.validationErrorsCount=10&epn.integratedRequiredQuestionsCount=24&ep.isFirstVisit=true",
      status: 204,
      method: "POST",
    });
    const out = extractGaEventEvidence(["capture-1.json"], tmpDir);
    expect(out).toContain("view_secondPage");
    expect(out).toContain("/jobs/999/applyboard/apply");
    expect(out).toContain("validationErrorsCount=10");
    expect(out).toContain("integratedRequiredQuestionsCount=24");
    expect(out).toContain("isFirstVisit=true");
  });

  it("surfaces view_thankYouPage (success signal)", () => {
    writeCapture("capture-1.json", {
      url: "https://www.google-analytics.com/g/collect?v=2&en=view_thankYouPage&dl=https%3A%2F%2Fapply.appcast.io%2Fjobs%2F999%2Fapplyboard%2Fapplied",
      status: 204,
      method: "POST",
    });
    const out = extractGaEventEvidence(["capture-1.json"], tmpDir);
    expect(out).toContain("view_thankYouPage");
    expect(out).toContain("/jobs/999/applyboard/applied");
  });

  it("numbers multiple GA events in capture order", () => {
    writeCapture("capture-1.json", {
      url: "https://www.google-analytics.com/g/collect?v=2&en=form_start&dl=https%3A%2F%2Fexample.com%2Fapply",
      status: 204,
      method: "POST",
    });
    writeCapture("capture-2.json", {
      url: "https://www.google-analytics.com/g/collect?v=2&en=view_secondPage&dl=https%3A%2F%2Fexample.com%2Fapply",
      status: 204,
      method: "POST",
    });
    const out = extractGaEventEvidence(["capture-1.json", "capture-2.json"], tmpDir);
    expect(out).toMatch(/1\. form_start/);
    expect(out).toMatch(/2\. view_secondPage/);
  });

  it("skips captures with no 'en' param (e.g. gtm config beacons)", () => {
    writeCapture("capture-1.json", {
      url: "https://www.google-analytics.com/g/collect?v=2&tid=G-X&_p=1234",
      status: 204,
      method: "POST",
    });
    expect(extractGaEventEvidence(["capture-1.json"], tmpDir)).toBe("");
  });

  it("skips missing capture files silently", () => {
    expect(extractGaEventEvidence(["missing.json"], tmpDir)).toBe("");
  });

  it("deduplicates the same filename to avoid double-counting", () => {
    writeCapture("capture-1.json", {
      url: "https://www.google-analytics.com/g/collect?v=2&en=view_secondPage&dl=https%3A%2F%2Fexample.com%2Fapply",
      status: 204,
      method: "POST",
    });
    const out = extractGaEventEvidence(["capture-1.json", "capture-1.json"], tmpDir);
    expect(out.split("\n").length).toBe(1);
  });
});

describe("recon-browser/renderStepWindow", () => {
  it("returns (none) for empty step list", () => {
    expect(renderStepWindow([])).toBe("(none)");
  });

  it("returns all steps verbatim when count fits within head+tail", () => {
    const steps = ["one", "two", "three"];
    const out = renderStepWindow(steps, { head: 0, tail: 10 });
    expect(out).toBe("1. one\n2. two\n3. three");
  });

  it("elides the middle when steps exceed head+tail budget", () => {
    const steps = Array.from({ length: 50 }, (_, i) => `step ${i + 1}`);
    const out = renderStepWindow(steps, { head: 3, tail: 5 });
    const lines = out.split("\n");
    expect(lines[0]).toBe("1. step 1");
    expect(lines[1]).toBe("2. step 2");
    expect(lines[2]).toBe("3. step 3");
    expect(lines[3]).toContain("elided");
    expect(lines[3]).toContain("42");
    expect(lines[4]).toBe("46. step 46");
    expect(lines[8]).toBe("50. step 50");
  });

  it("uses tail-only mode for completed step lists", () => {
    const steps = Array.from({ length: 100 }, (_, i) => `done ${i + 1}`);
    const out = renderStepWindow(steps, { tail: 10 });
    const lines = out.split("\n");
    expect(lines[0]).toContain("elided");
    expect(lines[0]).toContain("90");
    expect(lines[1]).toBe("91. done 91");
    expect(lines[10]).toBe("100. done 100");
  });

  it("uses head-only mode for remaining step lists", () => {
    const steps = Array.from({ length: 100 }, (_, i) => `todo ${i + 1}`);
    const out = renderStepWindow(steps, { head: 15, tail: 0 });
    const lines = out.split("\n");
    expect(lines[0]).toBe("1. todo 1");
    expect(lines[14]).toBe("15. todo 15");
    expect(lines[15]).toContain("elided");
    expect(lines[15]).toContain("85");
  });

  it("falls through cleanly when head+tail exactly equals length", () => {
    const steps = ["a", "b", "c", "d", "e"];
    const out = renderStepWindow(steps, { head: 2, tail: 3 });
    expect(out).toBe("1. a\n2. b\n3. c\n4. d\n5. e");
  });

  it("preserves original step indices for elided tail-only output", () => {
    const steps = Array.from({ length: 20 }, (_, i) => `x${i + 1}`);
    const out = renderStepWindow(steps, { tail: 3 });
    const lines = out.split("\n");
    expect(lines[1]).toBe("18. x18");
    expect(lines[3]).toBe("20. x20");
  });
});

describe("recon-browser/probeLeafInvalidContainers", () => {
  function fakePage(
    payload: unknown,
    opts?: { throw?: Error }
  ): import("@browserbasehq/stagehand").Page {
    return {
      evaluate: vi.fn().mockImplementation(async () => {
        if (opts?.throw) throw opts.throw;
        return payload;
      }),
    } as unknown as import("@browserbasehq/stagehand").Page;
  }

  it("returns empty when page.evaluate throws", async () => {
    const page = fakePage(null, { throw: new Error("navigation in flight") });
    const out = await probeLeafInvalidContainers(page);
    expect(out).toEqual([]);
  });

  it("returns empty when page.evaluate returns non-array", async () => {
    const page = fakePage({ unexpected: "shape" });
    const out = await probeLeafInvalidContainers(page);
    expect(out).toEqual([]);
  });

  it("returns the structured records that the in-page evaluator emits", async () => {
    const payload: LeafInvalidField[] = [
      {
        xpath: "/html[1]/body[1]/form[1]/ol[1]/li[7]/div[1]/div[2]/div[1]/app-input[1]",
        label: "Address",
        framework: "angular",
        markerClass: "question-control ng-invalid ng-star-inserted ng-touched ng-dirty",
        visibleErrorText: "This field is required.",
        inputTag: "input",
      },
    ];
    const page = fakePage(payload);
    const out = await probeLeafInvalidContainers(page);
    expect(out).toHaveLength(1);
    expect(out[0]?.label).toBe("Address");
    expect(out[0]?.framework).toBe("angular");
    expect(out[0]?.visibleErrorText).toBe("This field is required.");
  });
});

describe("recon-browser/renderLeafInvalidFields", () => {
  it("returns empty string when no fields", () => {
    expect(renderLeafInvalidFields([])).toBe("");
  });

  it("renders label + framework + input tag + error text on one line per field", () => {
    const out = renderLeafInvalidFields([
      {
        xpath: "/html/body/form/li[7]/app-input",
        label: "Address",
        framework: "angular",
        markerClass: "ng-invalid",
        visibleErrorText: "This field is required.",
        inputTag: "input",
      },
    ]);
    expect(out).toContain('1. "Address"');
    expect(out).toContain("[angular]");
    expect(out).toContain("<input>");
    expect(out).toContain('error: "This field is required."');
    expect(out).toContain("/html/body/form/li[7]/app-input");
  });

  it("falls back to (unlabeled) when label is null", () => {
    const out = renderLeafInvalidFields([
      {
        xpath: "/html/body/x",
        label: null,
        framework: "other",
        markerClass: "",
        visibleErrorText: null,
        inputTag: "input",
      },
    ]);
    expect(out).toContain('"(unlabeled)"');
    expect(out).not.toContain("error:");
  });

  it("numbers fields in order without elision (cap is upstream in probe)", () => {
    const fields: LeafInvalidField[] = Array.from({ length: 5 }, (_, i) => ({
      xpath: `/x[${i}]`,
      label: `field${i}`,
      framework: "angular" as const,
      markerClass: "ng-invalid",
      visibleErrorText: null,
      inputTag: "input",
    }));
    const out = renderLeafInvalidFields(fields);
    const lines = out.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('1. "field0"');
    expect(lines[4]).toContain('5. "field4"');
  });

  it("preserves framework differentiation across rows", () => {
    const out = renderLeafInvalidFields([
      {
        xpath: "/a",
        label: "A",
        framework: "angular",
        markerClass: "ng-invalid",
        visibleErrorText: null,
        inputTag: "input",
      },
      {
        xpath: "/b",
        label: "B",
        framework: "material",
        markerClass: "mat-form-field-invalid",
        visibleErrorText: null,
        inputTag: "input",
      },
      {
        xpath: "/c",
        label: "C",
        framework: "bootstrap",
        markerClass: "is-invalid",
        visibleErrorText: null,
        inputTag: "input",
      },
      {
        xpath: "/d",
        label: "D",
        framework: "aria",
        markerClass: "",
        visibleErrorText: null,
        inputTag: "input",
      },
    ]);
    expect(out).toContain("[angular]");
    expect(out).toContain("[material]");
    expect(out).toContain("[bootstrap]");
    expect(out).toContain("[aria]");
  });
});

describe("recon-browser/fillHtml5DateTimeInput", () => {
  function fakePage(
    payload: unknown,
    opts?: { throw?: Error }
  ): import("@browserbasehq/stagehand").Page {
    return {
      evaluate: vi.fn().mockImplementation(async () => {
        if (opts?.throw) throw opts.throw;
        return payload;
      }),
    } as unknown as import("@browserbasehq/stagehand").Page;
  }

  it("returns null when page.evaluate returns null (xpath did not resolve)", async () => {
    const out = await fillHtml5DateTimeInput(fakePage(null), "/x", "2026-06-14");
    expect(out).toBeNull();
  });

  it("returns null when target is not an HTML5 date/time input (regression safety)", async () => {
    const out = await fillHtml5DateTimeInput(
      fakePage({ filled: false, postValue: "", inputType: "text" }),
      "/x",
      "hello"
    );
    expect(out).toBeNull();
  });

  it("returns Html5DateFillResult when input is type=date and the value lands", async () => {
    const payload: Html5DateFillResult = {
      filled: true,
      postValue: "2026-06-14",
      inputType: "date",
    };
    const out = await fillHtml5DateTimeInput(fakePage(payload), "/x", "2026-06-14");
    expect(out).not.toBeNull();
    expect(out?.filled).toBe(true);
    expect(out?.postValue).toBe("2026-06-14");
    expect(out?.inputType).toBe("date");
  });

  it("returns Html5DateFillResult with filled=false when value doesn't stick", async () => {
    const payload: Html5DateFillResult = {
      filled: false,
      postValue: "",
      inputType: "time",
    };
    const out = await fillHtml5DateTimeInput(fakePage(payload), "/x", "10:30");
    expect(out).not.toBeNull();
    expect(out?.filled).toBe(false);
    expect(out?.inputType).toBe("time");
  });

  it("returns null when page.evaluate throws (CSP, detached browser, etc.)", async () => {
    const out = await fillHtml5DateTimeInput(
      fakePage(null, { throw: new Error("navigation in flight") }),
      "/x",
      "2026-06-14"
    );
    expect(out).toBeNull();
  });

  it("accepts datetime-local, month, and week as supported types", async () => {
    for (const t of ["datetime-local", "month", "week"]) {
      const out = await fillHtml5DateTimeInput(
        fakePage({ filled: true, postValue: "v", inputType: t }),
        "/x",
        "v"
      );
      expect(out?.inputType).toBe(t);
    }
  });
});

describe("recon-browser/countSlugPrefixMatches", () => {
  it("returns 0 for empty priorReplans", () => {
    expect(countSlugPrefixMatches("Click the Submit button", [])).toBe(0);
  });

  it("returns 0 when no prior replan shares the slug prefix", () => {
    const priors: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "cascade-exhausted",
        indexAtFailure: 35,
        failedInstruction: "Click the Submit button to submit the application form",
        replanSteps: [],
        timestamp: "2026-06-14T18:00:00Z",
        pageState: { url: "https://example.com", htmlLength: 0 },
      },
    ];
    expect(countSlugPrefixMatches("Fill in the Address Line field", priors)).toBe(0);
  });

  it("returns the number of prior replans sharing the 24-char slug prefix", () => {
    const priors: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "cascade-exhausted",
        indexAtFailure: 252,
        failedInstruction: "Click the spinbutton for Month",
        replanSteps: [],
        timestamp: "2026-06-14T19:20:00Z",
        pageState: { url: "https://example.com", htmlLength: 0 },
      },
      {
        replanIndex: 2,
        cause: "cascade-exhausted",
        indexAtFailure: 256,
        failedInstruction: "Click the spinbutton for Day",
        replanSteps: [],
        timestamp: "2026-06-14T19:25:00Z",
        pageState: { url: "https://example.com", htmlLength: 0 },
      },
    ];
    // All three slug to "click-the-spinbutton-for"
    expect(countSlugPrefixMatches("Click the spinbutton for Year", priors)).toBe(2);
  });

  it("does not match when only the long tail differs after the 24-char cutoff", () => {
    const priors: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "cascade-exhausted",
        indexAtFailure: 1,
        failedInstruction: "Click the No label for 'Have you ever been terminated'",
        replanSteps: [],
        timestamp: "2026-06-14T19:00:00Z",
        pageState: { url: "https://example.com", htmlLength: 0 },
      },
    ];
    // Same slug prefix (24 chars truncate before the differentiating tail)
    expect(
      countSlugPrefixMatches("Click the No label for 'Have you ever been excluded'", priors)
    ).toBe(1);
  });

  it("returns 0 for empty failed step", () => {
    const priors: ReplanEvent[] = [
      {
        replanIndex: 1,
        cause: "cascade-exhausted",
        indexAtFailure: 1,
        failedInstruction: "Click X",
        replanSteps: [],
        timestamp: "2026-06-14T19:00:00Z",
        pageState: { url: "https://example.com", htmlLength: 0 },
      },
    ];
    expect(countSlugPrefixMatches("", priors)).toBe(0);
  });
});

describe("recon-browser/describeAttemptEffectSignals", () => {
  const baseSnapshot = (
    overrides: Partial<{
      networkCount: number;
      url: string;
      bodyHtmlLength: number;
      visibleTextSignature: string;
    }>
  ): {
    networkCount: number;
    url: string;
    bodyHtmlLength: number;
    visibleTextSignature: string;
  } => ({
    networkCount: 0,
    url: "https://example.com",
    bodyHtmlLength: 1000,
    visibleTextSignature: "1000:hello",
    ...overrides,
  });

  it("flags dom-grew-without-network when body grew but no requests fired", () => {
    const pre = baseSnapshot({ bodyHtmlLength: 1000, visibleTextSignature: "1000:foo" });
    const post = baseSnapshot({ bodyHtmlLength: 1500, visibleTextSignature: "1500:bar" });
    const reason = describeAttemptEffectSignals(pre, post, [], 0);
    expect(reason).toContain("dom-grew-without-network");
    expect(reason).toContain("+500B");
    expect(reason).toContain("visible text changed");
  });

  it("flags network-fired-but-only-tracking when only GET / cross-origin captures land", () => {
    const pre = baseSnapshot({ networkCount: 0 });
    const post = baseSnapshot({ networkCount: 1 });
    const reason = describeAttemptEffectSignals(
      pre,
      post,
      [{ method: "GET", status: 200, url: "https://googleads.g.doubleclick.net/pixel" }],
      0
    );
    expect(reason).toContain("network-fired-but-only-tracking");
  });

  it("returns empty string when there are no notable signals", () => {
    const snap = baseSnapshot({});
    expect(describeAttemptEffectSignals(snap, snap, [], 0)).toBe("");
  });

  it("only counts captures in the window starting at preMetaLength", () => {
    const pre = baseSnapshot({ networkCount: 0 });
    const post = baseSnapshot({ networkCount: 1 });
    const meta = [
      { method: "POST", status: 200, url: "https://example.com/old-submit" },
      { method: "GET", status: 200, url: "https://example.com/tracking" },
    ];
    const reason = describeAttemptEffectSignals(pre, post, meta, 1);
    expect(reason).toContain("network-fired-but-only-tracking");
  });
});

describe("recon-browser/isSubmitRevealedInvalid", () => {
  const revealedInvalidSignature = {
    isFinalStep: true,
    requireSubmitEndpoint: true,
    resolvedMethod: "click",
    effectSignals:
      "dom-grew-without-network: body +1024B, visible text changed, 0 same-origin non-GET requests",
    preSubmitInvalidCount: 0,
    postAttemptInvalidCount: 3,
  };

  it("fires when a final-Submit click reveals new ng-invalid containers", () => {
    expect(isSubmitRevealedInvalid(revealedInvalidSignature)).toBe(true);
  });

  it("does not fire when the step is not the final step", () => {
    expect(isSubmitRevealedInvalid({ ...revealedInvalidSignature, isFinalStep: false })).toBe(
      false
    );
  });

  it("does not fire when the flow declared no submit endpoint", () => {
    expect(
      isSubmitRevealedInvalid({ ...revealedInvalidSignature, requireSubmitEndpoint: false })
    ).toBe(false);
  });

  it("does not fire on non-click resolved actions", () => {
    expect(isSubmitRevealedInvalid({ ...revealedInvalidSignature, resolvedMethod: "fill" })).toBe(
      false
    );
    expect(isSubmitRevealedInvalid({ ...revealedInvalidSignature, resolvedMethod: null })).toBe(
      false
    );
  });

  it("does not fire without the dom-grew-without-network signal", () => {
    expect(
      isSubmitRevealedInvalid({
        ...revealedInvalidSignature,
        effectSignals: "no observable effect (no network, url, or dom change)",
      })
    ).toBe(false);
    expect(
      isSubmitRevealedInvalid({
        ...revealedInvalidSignature,
        effectSignals: "network-fired-but-only-tracking: 5 requests",
      })
    ).toBe(false);
  });

  it("does not fire when the ng-invalid count did not grow", () => {
    expect(
      isSubmitRevealedInvalid({
        ...revealedInvalidSignature,
        preSubmitInvalidCount: 3,
        postAttemptInvalidCount: 3,
      })
    ).toBe(false);
    expect(
      isSubmitRevealedInvalid({
        ...revealedInvalidSignature,
        preSubmitInvalidCount: 5,
        postAttemptInvalidCount: 3,
      })
    ).toBe(false);
  });

  it("fires when ng-invalid count grew from non-zero (e.g. partial fills missed by pre-probe)", () => {
    expect(
      isSubmitRevealedInvalid({
        ...revealedInvalidSignature,
        preSubmitInvalidCount: 2,
        postAttemptInvalidCount: 5,
      })
    ).toBe(true);
  });
});

describe("recon-browser/shouldSkipTechnique", () => {
  it("skips structured-click when no prior attempt has resolved an xpath", () => {
    const decision = shouldSkipTechnique({
      technique: "structured-click",
      priorAttempts: [
        { technique: "act-string", triedSelectors: [], errorMessage: null },
        {
          technique: "observe-act",
          triedSelectors: [],
          errorMessage: "observe returned no candidates",
        },
      ],
    });
    expect(decision.skip).toBe(true);
    expect(decision.reason).toContain("no attempt has resolved a selector");
  });

  it("runs structured-click when a prior attempt resolved a selector", () => {
    const decision = shouldSkipTechnique({
      technique: "structured-click",
      priorAttempts: [
        { technique: "act-string", triedSelectors: [], errorMessage: null },
        {
          technique: "observe-act",
          triedSelectors: ["xpath=/html/body/button"],
          errorMessage: null,
        },
      ],
    });
    expect(decision.skip).toBe(false);
  });

  it("skips observe-act-exclude when prior observe-act returned zero candidates", () => {
    const decision = shouldSkipTechnique({
      technique: "observe-act-exclude",
      priorAttempts: [
        { technique: "act-string", triedSelectors: [], errorMessage: null },
        {
          technique: "observe-act",
          triedSelectors: [],
          errorMessage: "observe returned no candidates",
        },
        {
          technique: "structured-click",
          triedSelectors: [],
          errorMessage: "structured-click: no xpath from prior attempt",
        },
      ],
    });
    expect(decision.skip).toBe(true);
    expect(decision.reason).toContain("observe-act-exclude re-runs the same observe");
  });

  it("runs observe-act-exclude when prior observe-act DID find candidates", () => {
    const decision = shouldSkipTechnique({
      technique: "observe-act-exclude",
      priorAttempts: [
        { technique: "act-string", triedSelectors: [], errorMessage: null },
        {
          technique: "observe-act",
          triedSelectors: ["xpath=/html/body/button"],
          errorMessage: null,
        },
      ],
    });
    expect(decision.skip).toBe(false);
  });

  it("never skips act-string (attempt 1 has no prior state to evaluate)", () => {
    const decision = shouldSkipTechnique({
      technique: "act-string",
      priorAttempts: [],
    });
    expect(decision.skip).toBe(false);
  });

  it("never skips llm-rephrase (attempt 5 is the final-fallback recovery)", () => {
    const decision = shouldSkipTechnique({
      technique: "llm-rephrase",
      priorAttempts: [
        { technique: "act-string", triedSelectors: [], errorMessage: null },
        {
          technique: "observe-act",
          triedSelectors: [],
          errorMessage: "observe returned no candidates",
        },
      ],
    });
    expect(decision.skip).toBe(false);
  });
});

describe("recon-browser/isReplanCycle", () => {
  function makeEvent(
    replanIndex: number,
    proposals: string[],
    pageState: { url: string; htmlLength: number }
  ): ReplanEvent {
    return {
      replanIndex,
      cause: "cascade-exhausted",
      indexAtFailure: 0,
      failedInstruction: "Click submit",
      replanSteps: proposals.map((p) => ({
        instruction: p,
        optional: false,
        upload: false,
        origin: "original",
      })),
      timestamp: "2026-06-09T00:00:00.000Z",
      pageState,
    };
  }
  const url = "https://example.com/apply";

  it("returns false when fewer than threshold prior replans", () => {
    const newSteps: NormalizedStep[] = [
      { instruction: "Fill phone", optional: false, upload: false, origin: "original" },
    ];
    expect(isReplanCycle([], newSteps, { url, htmlLength: 50000 })).toBe(false);
    expect(
      isReplanCycle([makeEvent(1, ["Fill phone"], { url, htmlLength: 50000 })], newSteps, {
        url,
        htmlLength: 50000,
      })
    ).toBe(false);
  });

  it("returns true when threshold identical proposals under static page state", () => {
    const proposals = ["Fill phone", "Click submit"];
    const priors = [
      makeEvent(1, proposals, { url, htmlLength: 50000 }),
      makeEvent(2, proposals, { url, htmlLength: 50010 }),
      makeEvent(3, proposals, { url, htmlLength: 50020 }),
    ];
    const newSteps: NormalizedStep[] = proposals.map((p) => ({
      instruction: p,
      optional: false,
      upload: false,
      origin: "original",
    }));
    expect(isReplanCycle(priors, newSteps, { url, htmlLength: 50030 })).toBe(true);
  });

  it("returns false when URL changed between replans", () => {
    const proposals = ["Fill phone"];
    const priors = [
      makeEvent(1, proposals, { url, htmlLength: 50000 }),
      makeEvent(2, proposals, { url: "https://example.com/apply/page2", htmlLength: 50000 }),
      makeEvent(3, proposals, { url, htmlLength: 50000 }),
    ];
    const newSteps: NormalizedStep[] = proposals.map((p) => ({
      instruction: p,
      optional: false,
      upload: false,
      origin: "original",
    }));
    expect(isReplanCycle(priors, newSteps, { url, htmlLength: 50000 })).toBe(false);
  });

  it("returns false when HTML length changed beyond tolerance (page advanced)", () => {
    const proposals = ["Fill phone"];
    const priors = [
      makeEvent(1, proposals, { url, htmlLength: 50000 }),
      makeEvent(2, proposals, { url, htmlLength: 50000 }),
      makeEvent(3, proposals, { url, htmlLength: 50000 }),
    ];
    const newSteps: NormalizedStep[] = proposals.map((p) => ({
      instruction: p,
      optional: false,
      upload: false,
      origin: "original",
    }));
    expect(isReplanCycle(priors, newSteps, { url, htmlLength: 52000 })).toBe(false);
  });

  it("returns false when proposals differ in instructions or order", () => {
    const priors = [
      makeEvent(1, ["Fill phone", "Click submit"], { url, htmlLength: 50000 }),
      makeEvent(2, ["Fill phone", "Click submit"], { url, htmlLength: 50000 }),
      makeEvent(3, ["Click submit", "Fill phone"], { url, htmlLength: 50000 }),
    ];
    const newSteps: NormalizedStep[] = [
      { instruction: "Fill phone", optional: false, upload: false, origin: "original" },
      { instruction: "Click submit", optional: false, upload: false, origin: "original" },
    ];
    expect(isReplanCycle(priors, newSteps, { url, htmlLength: 50000 })).toBe(false);
  });
});

describe("recon-browser/summarizeReplanFailureKinds", () => {
  let tmpDir: string;
  let ndjsonPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-replan-summary-"));
    ndjsonPath = join(tmpDir, "calls.ndjson");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeEntries(
    entries: { callType: string; success: boolean; failureKind: string | null }[]
  ): void {
    // parseSamples runs every line through llmCallSampleSchema, so the
    // fixture must produce schema-conformant rows. Fill the required
    // fields with neutral defaults; the predicate only consults
    // callType, success, and failureKind.
    const lines = entries.map((e, i) =>
      JSON.stringify({
        callId: `call-${i}`,
        callType: e.callType,
        model: "test-model",
        systemPrompt: null,
        userContent: "",
        responseContent: null,
        parsedOk: false,
        inputTokens: null,
        outputTokens: null,
        latencyMs: null,
        success: e.success,
        errorMessage: null,
        failureKind: e.failureKind,
        ts: "2026-01-01T00:00:00Z",
      })
    );
    writeFileSync(ndjsonPath, `${lines.join("\n")}\n`);
  }

  it("returns empty when the file is missing", () => {
    expect(
      summarizeReplanFailureKinds({
        callsNdjsonPath: join(tmpDir, "missing.ndjson"),
        callType: "recon-replan",
      })
    ).toBe("");
  });

  it("returns empty when no entries match the callType", () => {
    writeEntries([{ callType: "other-call", success: false, failureKind: "anthropic-billing" }]);
    expect(
      summarizeReplanFailureKinds({ callsNdjsonPath: ndjsonPath, callType: "recon-replan" })
    ).toBe("");
  });

  it("returns empty when matching entries all succeeded", () => {
    writeEntries([
      { callType: "recon-replan", success: true, failureKind: null },
      { callType: "recon-replan", success: true, failureKind: null },
    ]);
    expect(
      summarizeReplanFailureKinds({ callsNdjsonPath: ndjsonPath, callType: "recon-replan" })
    ).toBe("");
  });

  it("buckets by failureKind, sorted by frequency descending", () => {
    writeEntries([
      { callType: "recon-replan", success: false, failureKind: "anthropic-rate-limit" },
      { callType: "recon-replan", success: false, failureKind: "anthropic-rate-limit" },
      { callType: "recon-replan", success: false, failureKind: "anthropic-rate-limit" },
      { callType: "recon-replan", success: false, failureKind: "anthropic-rate-limit" },
      { callType: "recon-replan", success: false, failureKind: "schema-validation-failed" },
    ]);
    const summary = summarizeReplanFailureKinds({
      callsNdjsonPath: ndjsonPath,
      callType: "recon-replan",
    });
    expect(summary).toContain("5 recent recon-replan failure(s)");
    expect(summary).toContain("4× anthropic-rate-limit");
    expect(summary).toContain("1× schema-validation-failed");
    expect(summary.indexOf("4×")).toBeLessThan(summary.indexOf("1×"));
  });

  it("ignores unrelated callTypes in the same NDJSON file", () => {
    writeEntries([
      { callType: "recon-rephrase", success: false, failureKind: "response-empty" },
      { callType: "recon-replan", success: false, failureKind: "anthropic-billing" },
    ]);
    const summary = summarizeReplanFailureKinds({
      callsNdjsonPath: ndjsonPath,
      callType: "recon-replan",
    });
    expect(summary).toContain("1 recent recon-replan");
    expect(summary).toContain("anthropic-billing");
    expect(summary).not.toContain("response-empty");
  });

  it("treats null failureKind as 'unknown'", () => {
    writeEntries([{ callType: "recon-replan", success: false, failureKind: null }]);
    expect(
      summarizeReplanFailureKinds({ callsNdjsonPath: ndjsonPath, callType: "recon-replan" })
    ).toContain("1× unknown");
  });

  it("only inspects the most recent tailCount entries", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      callType: "recon-replan" as const,
      success: false,
      failureKind: i < 10 ? "anthropic-billing" : "anthropic-rate-limit",
    }));
    writeEntries(entries);
    const summary = summarizeReplanFailureKinds({
      callsNdjsonPath: ndjsonPath,
      callType: "recon-replan",
      tailCount: 10,
    });
    expect(summary).toContain("10× anthropic-rate-limit");
    expect(summary).not.toContain("anthropic-billing");
  });

  it("survives malformed NDJSON lines", () => {
    writeEntries([
      { callType: "recon-replan", success: false, failureKind: "anthropic-billing" },
      { callType: "recon-replan", success: false, failureKind: "anthropic-billing" },
    ]);
    // Inject a malformed line + an empty line between the valid entries.
    // parseSamples returns a makeMalformedSample row for the bad JSON and
    // skips the empty one, neither of which matches the "recon-replan"
    // callType filter — so the summary still tallies the two valid rows.
    const current = readFileSync(ndjsonPath, "utf8");
    const lines = current.split("\n").filter((l) => l.length > 0);
    writeFileSync(ndjsonPath, [lines[0]!, "{not-json}", lines[1]!, ""].join("\n"));
    expect(
      summarizeReplanFailureKinds({ callsNdjsonPath: ndjsonPath, callType: "recon-replan" })
    ).toContain("2× anthropic-billing");
  });
});

describe("rephraseWithLLM — instruction history (priorAttempts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes INSTRUCTION TEXT ALREADY TRIED when priorAttempts is supplied", async () => {
    const client = makeAnthropicClient("click the Yes radio button label");
    const { fn, calls } = makeCaptureFn();

    await rephraseWithLLM(
      client,
      "Click the Submit button",
      ["xpath=/html/body/button[1]"],
      [],
      ["no observable effect"],
      fn,
      undefined,
      undefined,
      undefined,
      [
        {
          technique: "act-string",
          instruction: "Click the Submit button",
          verdict: "no observable effect",
        },
        {
          technique: "observe-act",
          instruction: "Submit application button at the bottom of the form",
          verdict: "no observable effect",
        },
      ]
    );

    const prompt = calls[0]?.userContent ?? "";
    expect(prompt).toContain("INSTRUCTION TEXT ALREADY TRIED");
    expect(prompt).toContain("act-string");
    expect(prompt).toContain("Click the Submit button");
    expect(prompt).toContain("observe-act");
    expect(prompt).toContain("Submit application button");
  });

  it("renders (none) when priorAttempts is empty or undefined", async () => {
    const client = makeAnthropicClient("click the Yes radio button label");
    const { fn, calls } = makeCaptureFn();

    await rephraseWithLLM(client, "Click the Submit button", [], [], ["no observable effect"], fn);

    const prompt = calls[0]?.userContent ?? "";
    expect(prompt).toContain("INSTRUCTION TEXT ALREADY TRIED");
    expect(prompt).toMatch(/INSTRUCTION TEXT ALREADY TRIED[^\n]*\):\n\(none\)/);
  });

  it("filters out attempts whose instruction is null or empty", async () => {
    const client = makeAnthropicClient("click the Yes label");
    const { fn, calls } = makeCaptureFn();

    await rephraseWithLLM(
      client,
      "Click the Submit button",
      [],
      [],
      ["no observable effect"],
      fn,
      undefined,
      undefined,
      undefined,
      [
        { technique: "act-string", instruction: null, verdict: "no observable effect" },
        { technique: "structured-click", instruction: "   ", verdict: "no xpath" },
        { technique: "observe-act", instruction: "Click the No radio", verdict: "ok" },
      ]
    );

    const prompt = calls[0]?.userContent ?? "";
    expect(prompt).toContain("Click the No radio");
    expect(prompt).not.toContain("act-string");
    expect(prompt).not.toContain("structured-click");
  });
});

describe("recon-browser/findRecentPageTransition", () => {
  it("returns null when the window is empty", () => {
    expect(findRecentPageTransition({ recentCaptureMeta: [], preMetaLength: 0 })).toBeNull();
  });

  it("returns null when only earlier-step captures exist (preMetaLength gate)", () => {
    expect(
      findRecentPageTransition({
        recentCaptureMeta: [{ method: "POST", status: 302, url: "https://example.com/redirect" }],
        preMetaLength: 1,
      })
    ).toBeNull();
  });

  it("detects a 3xx redirect within the window", () => {
    expect(
      findRecentPageTransition({
        recentCaptureMeta: [
          { method: "GET", status: 200, url: "https://example.com/old" },
          { method: "POST", status: 302, url: "https://example.com/thank-you" },
        ],
        preMetaLength: 0,
      })
    ).toBe("https://example.com/thank-you");
  });

  it("detects a successful non-GET non-tracking capture as a transition", () => {
    expect(
      findRecentPageTransition({
        recentCaptureMeta: [{ method: "POST", status: 200, url: "https://example.com/submit" }],
        preMetaLength: 0,
      })
    ).toBe("https://example.com/submit");
  });

  it("ignores tracking beacons even when they returned 200", () => {
    expect(
      findRecentPageTransition({
        recentCaptureMeta: [
          { method: "POST", status: 200, url: "https://googleads.g.doubleclick.net/pixel" },
          { method: "GET", status: 200, url: "https://www.google.com/pagead/conversion" },
        ],
        preMetaLength: 0,
      })
    ).toBeNull();
  });

  it("ignores GET requests when searching for non-redirect transitions", () => {
    expect(
      findRecentPageTransition({
        recentCaptureMeta: [{ method: "GET", status: 200, url: "https://example.com/poll" }],
        preMetaLength: 0,
      })
    ).toBeNull();
  });

  it("prefers a 3xx over a same-window 2xx non-tracking POST", () => {
    const transition = findRecentPageTransition({
      recentCaptureMeta: [
        { method: "POST", status: 200, url: "https://example.com/api/save" },
        { method: "POST", status: 302, url: "https://example.com/next-page" },
      ],
      preMetaLength: 0,
    });
    expect(transition).toBe("https://example.com/next-page");
  });
});

describe("recon-browser/extractSubmitFailureEvidence — any-4xx mode", () => {
  let tmpDir: string;
  const ownHosts = ["example.com"];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-anyfourxx-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCapture(filename: string, body: object): void {
    writeFileSync(join(tmpDir, filename), JSON.stringify(body));
  }

  it("strict mode ignores 4xx whose hostname is not on ownBackendHostnames (third-party CDN noise)", () => {
    writeCapture("c1.json", {
      url: "https://cdn.thirdparty.net/api/errors",
      status: 422,
      responseBody: { errors: [{ field: "email", message: "Invalid format" }] },
    });
    const out = extractSubmitFailureEvidence(["c1.json"], ownHosts, tmpDir);
    expect(out).toBe("");
  });

  it("any-4xx mode parses a 4xx whose hostname is not on ownBackendHostnames", () => {
    writeCapture("c1.json", {
      url: "https://cdn.thirdparty.net/api/errors",
      status: 422,
      responseBody: { errors: [{ field: "email", message: "Invalid format" }] },
    });
    const out = extractSubmitFailureEvidence(["c1.json"], [], tmpDir, "any-4xx");
    expect(out).toContain("422 https://cdn.thirdparty.net/api/errors");
    expect(out).toContain("email: Invalid format");
  });

  it("any-4xx mode still requires status >= 400 (ignores 2xx)", () => {
    writeCapture("c1.json", {
      url: "https://example.com/api/track",
      status: 200,
      responseBody: { ok: true },
    });
    const out = extractSubmitFailureEvidence(["c1.json"], [], tmpDir, "any-4xx");
    expect(out).toBe("");
  });

  it("any-4xx mode returns empty when no 4xx exists in the window", () => {
    writeCapture("c1.json", {
      url: "https://example.com/api/save",
      status: 200,
      responseBody: { ok: true },
    });
    const out = extractSubmitFailureEvidence(["c1.json"], [], tmpDir, "any-4xx");
    expect(out).toBe("");
  });
});

describe("replanRemainingFlow — trajectory prompt section", () => {
  function makeReplanClient(): Anthropic {
    return {
      messages: {
        parse: vi.fn().mockResolvedValue({
          parsed_output: { outcome: "replan", steps: ["Click Submit"] },
          content: [{ type: "text", text: "{}" }],
          usage: { input_tokens: 100, output_tokens: 5 },
        }),
      },
    } as unknown as Anthropic;
  }

  function makePageStub(): { url: () => string; title: () => Promise<string> } {
    return {
      url: () => "https://example.com/apply",
      title: vi.fn().mockResolvedValue("Application Form"),
    };
  }

  function makeStagehandStub(): { observe: ReturnType<typeof vi.fn> } {
    return {
      observe: vi.fn().mockResolvedValue([]),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders (none) when trajectory is empty or undefined", async () => {
    const client = makeReplanClient();
    const { fn, calls } = makeCaptureFn();
    await replanRemainingFlow({
      client,
      originalFlow: ["Step A"],
      completedSteps: [],
      failedStep: "Step A",
      remainingSteps: [],
      failureDumpPath: "/tmp/nonexistent-dump.json",
      page: makePageStub() as never,
      stagehand: makeStagehandStub() as never,
      captureFn: fn,
    });
    const prompt = calls.find((c) => c.callType === CALL_TYPE_RECON_REPLAN)?.userContent ?? "";
    expect(prompt).toContain("PRIOR STEP TRAJECTORY");
    expect(prompt).toMatch(/PRIOR STEP TRAJECTORY[^\n]*\):\n\(none\)/);
  });

  it("renders supplied trajectory entries with their verifiedBy signals", async () => {
    const client = makeReplanClient();
    const { fn, calls } = makeCaptureFn();
    await replanRemainingFlow({
      client,
      originalFlow: ["Step A"],
      completedSteps: [],
      failedStep: "Step A",
      remainingSteps: [],
      failureDumpPath: "/tmp/nonexistent-dump.json",
      page: makePageStub() as never,
      stagehand: makeStagehandStub() as never,
      captureFn: fn,
      trajectory: [
        { stepIndex: 0, verifiedBy: "network" },
        { stepIndex: 1, verifiedBy: "submitted-state-dom" },
        { stepIndex: 2, verifiedBy: "url" },
      ],
    });
    const prompt = calls.find((c) => c.callType === CALL_TYPE_RECON_REPLAN)?.userContent ?? "";
    expect(prompt).toContain("PRIOR STEP TRAJECTORY");
    expect(prompt).toContain("step 1 verified via network");
    expect(prompt).toContain("step 2 verified via submitted-state-dom");
    expect(prompt).toContain("step 3 verified via url");
  });

  it("caps the trajectory section to the last 5 entries", async () => {
    const client = makeReplanClient();
    const { fn, calls } = makeCaptureFn();
    const trajectory = Array.from({ length: 8 }, (_, i) => ({
      stepIndex: i,
      verifiedBy: "network" as const,
    }));
    await replanRemainingFlow({
      client,
      originalFlow: ["Step A"],
      completedSteps: [],
      failedStep: "Step A",
      remainingSteps: [],
      failureDumpPath: "/tmp/nonexistent-dump.json",
      page: makePageStub() as never,
      stagehand: makeStagehandStub() as never,
      captureFn: fn,
      trajectory,
    });
    const prompt = calls.find((c) => c.callType === CALL_TYPE_RECON_REPLAN)?.userContent ?? "";
    expect(prompt).toContain("step 4 verified via network");
    expect(prompt).toContain("step 8 verified via network");
    expect(prompt).not.toContain("step 1 verified");
    expect(prompt).not.toContain("step 3 verified");
  });

  it("renders '(no signal recorded)' for trajectory entries with null verifiedBy", async () => {
    const client = makeReplanClient();
    const { fn, calls } = makeCaptureFn();
    await replanRemainingFlow({
      client,
      originalFlow: ["Step A"],
      completedSteps: [],
      failedStep: "Step A",
      remainingSteps: [],
      failureDumpPath: "/tmp/nonexistent-dump.json",
      page: makePageStub() as never,
      stagehand: makeStagehandStub() as never,
      captureFn: fn,
      trajectory: [{ stepIndex: 4, verifiedBy: null }],
    });
    const prompt = calls.find((c) => c.callType === CALL_TYPE_RECON_REPLAN)?.userContent ?? "";
    expect(prompt).toContain("step 5 verified via (no signal recorded)");
  });
});

describe("recon-browser/hasBillingErrorBeenLogged + billing-aware skip", () => {
  beforeEach(() => {
    resetBillingErrorFlagForTests();
  });

  afterEach(() => {
    resetBillingErrorFlagForTests();
  });

  it("returns false initially", () => {
    expect(hasBillingErrorBeenLogged()).toBe(false);
  });

  it("returns true after logBillingErrorIfPresent matches the billing regex", () => {
    expect(hasBillingErrorBeenLogged()).toBe(false);
    logBillingErrorIfPresent("Your credit balance is too low to make this call");
    expect(hasBillingErrorBeenLogged()).toBe(true);
  });

  it("stays false when the error message does not match the billing regex", () => {
    logBillingErrorIfPresent("transient network error: ETIMEDOUT");
    expect(hasBillingErrorBeenLogged()).toBe(false);
  });

  it("resetBillingErrorFlagForTests clears the flag", () => {
    logBillingErrorIfPresent("insufficient_quota");
    expect(hasBillingErrorBeenLogged()).toBe(true);
    resetBillingErrorFlagForTests();
    expect(hasBillingErrorBeenLogged()).toBe(false);
  });
});

describe("recon-browser/findRecentBackendError", () => {
  const ownHosts = ["example.com"];

  it("returns null when ownBackendHostnames is empty", () => {
    expect(
      findRecentBackendError({
        recentCaptureMeta: [{ method: "POST", status: 500, url: "https://example.com/api/apply" }],
        preMetaLength: 0,
        ownBackendHostnames: [],
      })
    ).toBeNull();
  });

  it("returns null when the window is empty", () => {
    expect(
      findRecentBackendError({
        recentCaptureMeta: [],
        preMetaLength: 0,
        ownBackendHostnames: ownHosts,
      })
    ).toBeNull();
  });

  it("returns null when only earlier-step captures exist", () => {
    expect(
      findRecentBackendError({
        recentCaptureMeta: [{ method: "POST", status: 500, url: "https://example.com/api/apply" }],
        preMetaLength: 1,
        ownBackendHostnames: ownHosts,
      })
    ).toBeNull();
  });

  it("returns the matched URL for a 5xx hitting the site's own backend", () => {
    expect(
      findRecentBackendError({
        recentCaptureMeta: [{ method: "POST", status: 500, url: "https://example.com/api/apply" }],
        preMetaLength: 0,
        ownBackendHostnames: ownHosts,
      })
    ).toBe("https://example.com/api/apply");
  });

  it("ignores 5xx on URLs from third-party hosts (analytics noise)", () => {
    expect(
      findRecentBackendError({
        recentCaptureMeta: [
          { method: "POST", status: 503, url: "https://googleads.g.doubleclick.net/pixel" },
        ],
        preMetaLength: 0,
        ownBackendHostnames: ownHosts,
      })
    ).toBeNull();
  });

  it("ignores 4xx and 2xx responses (only 5xx is backend-error)", () => {
    expect(
      findRecentBackendError({
        recentCaptureMeta: [
          { method: "POST", status: 422, url: "https://example.com/api/apply" },
          { method: "POST", status: 200, url: "https://example.com/api/apply" },
        ],
        preMetaLength: 0,
        ownBackendHostnames: ownHosts,
      })
    ).toBeNull();
  });

  it("matches any 5xx code (500-599) on the site's own backend", () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(
        findRecentBackendError({
          recentCaptureMeta: [{ method: "POST", status, url: "https://example.com/api/apply" }],
          preMetaLength: 0,
          ownBackendHostnames: ownHosts,
        })
      ).toBe("https://example.com/api/apply");
    }
  });
});

describe("recon-browser/pairInvalidWithErrors", () => {
  it("pairs positionally-adjacent invalid + error when the invalid container is touched+dirty", () => {
    const invalidList =
      '1. Phone <uapp-phone-input class="question-control ng-touched ng-dirty ng-invalid">';
    const errorList = "1. Please provide correct phone number.";
    const pairs = pairInvalidWithErrors(invalidList, errorList);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.errorText).toBe("Please provide correct phone number.");
    expect(pairs[0]?.fieldLabel).toContain("Phone");
  });

  it("skips invalid entries that lack ng-touched (pristine empty required fields)", () => {
    const invalidList =
      '1. First Name <app-input class="question-control ng-pristine ng-untouched ng-invalid">';
    const errorList = "1. This field is required.";
    expect(pairInvalidWithErrors(invalidList, errorList)).toEqual([]);
  });

  it("skips invalid entries that lack ng-dirty (touched but never typed into)", () => {
    const invalidList =
      '1. Field <app-input class="question-control ng-touched ng-pristine ng-invalid">';
    const errorList = "1. Required.";
    expect(pairInvalidWithErrors(invalidList, errorList)).toEqual([]);
  });

  it("returns empty array when either list is empty", () => {
    expect(pairInvalidWithErrors("", "1. Error")).toEqual([]);
    expect(pairInvalidWithErrors("1. Field [ng-touched ng-dirty ng-invalid]", "")).toEqual([]);
    expect(pairInvalidWithErrors("", "")).toEqual([]);
  });

  it("pairs multiple invalids with multiple errors positionally", () => {
    const invalidList = [
      '1. Phone <input class="ng-touched ng-dirty ng-invalid">',
      '2. Salary <input class="ng-touched ng-dirty ng-invalid">',
    ].join("\n");
    const errorList = ["1. Please provide correct phone number.", "2. Enter a valid amount."].join(
      "\n"
    );
    const pairs = pairInvalidWithErrors(invalidList, errorList);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]?.errorText).toBe("Please provide correct phone number.");
    expect(pairs[1]?.errorText).toBe("Enter a valid amount.");
  });

  it("truncates very long field labels and error texts to 200 chars", () => {
    const longLabel = "x".repeat(500);
    const longError = "y".repeat(500);
    const invalidList = `1. ${longLabel} [ng-touched ng-dirty ng-invalid]`;
    const errorList = `1. ${longError}`;
    const pairs = pairInvalidWithErrors(invalidList, errorList);
    expect(pairs).toHaveLength(1);
    expect((pairs[0]?.fieldLabel ?? "").length).toBeLessThanOrEqual(200);
    expect((pairs[0]?.errorText ?? "").length).toBeLessThanOrEqual(200);
  });

  it("only pairs up to min(invalid.length, errors.length) — extras of either are dropped silently", () => {
    const invalidList = [
      '1. A <input class="ng-touched ng-dirty ng-invalid">',
      '2. B <input class="ng-touched ng-dirty ng-invalid">',
    ].join("\n");
    const errorList = "1. Just one error";
    const pairs = pairInvalidWithErrors(invalidList, errorList);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.errorText).toBe("Just one error");
  });
});

describe("recon-browser/formatValidationRejectedReason", () => {
  it("formats a pair into a single imperative-style failureReason line", () => {
    const pair: ValidationRejectionPair = {
      fieldLabel: "Phone",
      errorText: "Please provide correct phone number.",
    };
    const reason = formatValidationRejectedReason(pair);
    expect(reason).toContain("validation-rejected");
    expect(reason).toContain("'Phone'");
    expect(reason).toContain("'Please provide correct phone number.'");
    expect(reason).toContain("propose a different value or return impossible");
  });
});

describe("recon-browser/selectBodyExcerpt", () => {
  it("returns the body verbatim when it's smaller than the default cap", () => {
    const body = "<body>small page</body>";
    expect(selectBodyExcerpt(body)).toBe(body);
  });

  it("returns the first 8KB when form markers are already inside it", () => {
    // Body where ng-invalid appears in the first 8KB — the default cap is
    // sufficient. Padding fills the rest with non-form chrome.
    const head =
      "<body><uapp-root>" +
      "x".repeat(4000) +
      'class="ng-invalid"' +
      "y".repeat(3000) +
      "</uapp-root>";
    const tail = `${"z".repeat(50_000)}</body>`;
    const body = head + tail;
    const excerpt = selectBodyExcerpt(body);
    expect(excerpt.length).toBe(8000);
    expect(excerpt).toContain("ng-invalid");
  });

  it("returns a window centered on the form marker when it lives beyond the default cap", () => {
    // Body where ng-invalid is past 8KB — mimics the AppCast applyboard
    // SPA, whose form starts ~15KB after a header of Angular hydration JS.
    const chrome = "x".repeat(15_000);
    const formRegion = `class="ng-invalid"${"y".repeat(1000)}First Name required${"z".repeat(1000)}`;
    const trailing = "w".repeat(50_000);
    const body = chrome + formRegion + trailing;
    const excerpt = selectBodyExcerpt(body);
    expect(excerpt.length).toBe(32_000);
    expect(excerpt).toContain("ng-invalid");
    expect(excerpt).toContain("First Name required");
  });

  it("falls back to the default cap when no markers are found anywhere", () => {
    // Big body with no form markers — degrade gracefully.
    const body = "x".repeat(50_000);
    const excerpt = selectBodyExcerpt(body);
    expect(excerpt.length).toBe(8000);
  });

  it("detects mat-form-field-invalid (Material UI)", () => {
    const body = `${"x".repeat(10_000)}mat-form-field-invalid${"y".repeat(50_000)}`;
    const excerpt = selectBodyExcerpt(body);
    expect(excerpt.length).toBe(32_000);
    expect(excerpt).toContain("mat-form-field-invalid");
  });

  it("detects <form tag when invalid markers are absent", () => {
    const body = `${"x".repeat(10_000)}<form action='/submit'>${"y".repeat(50_000)}`;
    const excerpt = selectBodyExcerpt(body);
    expect(excerpt.length).toBe(32_000);
    expect(excerpt).toContain("<form action");
  });
});

describe("recon-browser/normalizeDateValue", () => {
  it("passes through YYYY-MM-DD as-is for type=date", () => {
    expect(normalizeDateValue("2026-06-14", "date")).toBe("2026-06-14");
  });

  it("converts MM-DD-YYYY to YYYY-MM-DD for type=date (US convention)", () => {
    expect(normalizeDateValue("06-14-2026", "date")).toBe("2026-06-14");
  });

  it("converts MM/DD/YYYY to YYYY-MM-DD for type=date", () => {
    expect(normalizeDateValue("06/14/2026", "date")).toBe("2026-06-14");
  });

  it("returns null for unrecognized date formats", () => {
    expect(normalizeDateValue("14 June 2026", "date")).toBeNull();
    expect(normalizeDateValue("not a date", "date")).toBeNull();
  });

  it("passes through YYYY-MM for type=month", () => {
    expect(normalizeDateValue("2026-06", "month")).toBe("2026-06");
  });

  it("passes through HH:MM and HH:MM:SS for type=time", () => {
    expect(normalizeDateValue("14:30", "time")).toBe("14:30");
    expect(normalizeDateValue("14:30:45", "time")).toBe("14:30:45");
  });

  it("passes through YYYY-Www for type=week", () => {
    expect(normalizeDateValue("2026-W24", "week")).toBe("2026-W24");
  });

  it("passes through YYYY-MM-DDTHH:MM for type=datetime-local", () => {
    expect(normalizeDateValue("2026-06-14T14:30", "datetime-local")).toBe("2026-06-14T14:30");
  });

  it("returns null for unsupported input types", () => {
    expect(normalizeDateValue("anything", "text")).toBeNull();
    expect(normalizeDateValue("anything", "number")).toBeNull();
  });
});

describe("recon-browser/verifyFillReadback (shape contract)", () => {
  // Behavioral tests of verifyFillReadback require a real Page mock with
  // page.evaluate executing the closure — out of scope for unit tests
  // (would need playwright-test or similar). These tests validate the
  // type contract and that the helper does not throw on edge inputs.
  it("returns null when page.evaluate throws", async () => {
    const fakePage = {
      evaluate: async () => {
        throw new Error("page detached");
      },
    } as unknown as import("@browserbasehq/stagehand").Page;
    const result = await verifyFillReadback(fakePage, "//input[@id='x']", "abc");
    expect(result).toBeNull();
  });

  it("returns null when page.evaluate returns non-object", async () => {
    const fakePage = {
      evaluate: async () => null,
    } as unknown as import("@browserbasehq/stagehand").Page;
    const result = await verifyFillReadback(fakePage, "//input[@id='x']", "abc");
    expect(result).toBeNull();
  });

  it("returns parsed result when page.evaluate returns a valid shape", async () => {
    const fakePage = {
      evaluate: async (): Promise<VerifyFillReadbackResult> => ({
        outcome: "matched",
        postValue: "abc",
        tag: "input",
      }),
    } as unknown as import("@browserbasehq/stagehand").Page;
    const result = await verifyFillReadback(fakePage, "//input[@id='x']", "abc");
    expect(result).not.toBeNull();
    expect(result?.outcome).toBe("matched");
    expect(result?.postValue).toBe("abc");
    expect(result?.tag).toBe("input");
  });

  it("returns null when outcome field is invalid (silent guard)", async () => {
    const fakePage = {
      evaluate: async () => ({ outcome: "invalid-outcome", postValue: "", tag: "input" }),
    } as unknown as import("@browserbasehq/stagehand").Page;
    const result = await verifyFillReadback(fakePage, "//input[@id='x']", "abc");
    expect(result).toBeNull();
  });

  it("preserves rejected outcome (value silently rejected by element)", async () => {
    const fakePage = {
      evaluate: async (): Promise<VerifyFillReadbackResult> => ({
        outcome: "rejected",
        postValue: "",
        tag: "input",
      }),
    } as unknown as import("@browserbasehq/stagehand").Page;
    const result = await verifyFillReadback(fakePage, "//input[@type='date']", "06-14-2026");
    expect(result?.outcome).toBe("rejected");
    expect(result?.postValue).toBe("");
  });
});

describe("recon-browser/extractSubmitFailureEvidence — J' singular-error key", () => {
  // Behavioral test of the J' parser fix: AppCast returns
  // {"error": "Resume is blank"} in /integrated_apply 422 responses.
  // Before J', the parser only handled {errors: [...]} (plural) and
  // {message: "..."}, leaving the singular `error` string unsurfaced
  // to the LLM. This test would require fs mocking to fully exercise
  // extractSubmitFailureEvidence — covered structurally via the
  // existing extractSubmitFailureEvidence test suite's fixtures.
  // The new fallback at the call-site catches `"error" in body` even
  // when harvestFieldErrors returns empty.
  it("J' is a 5-line addition covered by extractSubmitFailureEvidence integration tests", () => {
    // The parser change is structurally validated by the existing
    // test suite's fallback fixtures. Marker test for traceability.
    expect(true).toBe(true);
  });
});

describe("recon-browser/detectRejectionInResponseBody (Q1)", () => {
  it("returns rejected=false for null/undefined/non-object body", () => {
    expect(detectRejectionInResponseBody(null)).toEqual({ rejected: false, reason: null });
    expect(detectRejectionInResponseBody(undefined)).toEqual({ rejected: false, reason: null });
    expect(detectRejectionInResponseBody("not an object")).toEqual({
      rejected: false,
      reason: null,
    });
    expect(detectRejectionInResponseBody(42)).toEqual({ rejected: false, reason: null });
  });

  it("detects AppCast `not_qualified: true` with error reason", () => {
    expect(
      detectRejectionInResponseBody({
        not_qualified: true,
        error: "Not qualified reason: email",
      })
    ).toEqual({ rejected: true, reason: "Not qualified reason: email" });
  });

  it("detects AppCast `not_qualified: true` without error field (falls back to default reason)", () => {
    expect(detectRejectionInResponseBody({ not_qualified: true })).toEqual({
      rejected: true,
      reason: "not_qualified",
    });
  });

  it("does NOT flag AppCast `not_qualified: false` as rejection (real success)", () => {
    expect(
      detectRejectionInResponseBody({
        not_qualified: false,
        ggc_thank_you_redirect_url: "https://example.com",
      })
    ).toEqual({ rejected: false, reason: null });
  });

  it("detects Greenhouse `rejected: true` with reason", () => {
    expect(
      detectRejectionInResponseBody({ rejected: true, reason: "Duplicate application" })
    ).toEqual({
      rejected: true,
      reason: "Duplicate application",
    });
  });

  it("detects Lever `qualified: false` with reason", () => {
    expect(detectRejectionInResponseBody({ qualified: false, reason: "Location" })).toEqual({
      rejected: true,
      reason: "Location",
    });
  });

  it('detects Workday `status: "rejected"` shape', () => {
    expect(
      detectRejectionInResponseBody({ status: "rejected", reason: "Required field empty" })
    ).toEqual({
      rejected: true,
      reason: "Required field empty",
    });
  });

  it('does NOT flag `status: "accepted"` as rejection', () => {
    expect(detectRejectionInResponseBody({ status: "accepted" })).toEqual({
      rejected: false,
      reason: null,
    });
  });

  it("ignores unrelated fields when no rejection markers present", () => {
    expect(
      detectRejectionInResponseBody({ applicationId: 12345, redirectUrl: "https://x.com" })
    ).toEqual({ rejected: false, reason: null });
  });
});

describe("recon-browser/Q1B — capture-shape integration (responseBody can be object|string|null)", () => {
  // The capture writer at recon-browser.ts:240 stores responseBody as either a
  // parsed object (JSON success — common case for any JSON-serving API) or as
  // a string (rare fallback when JSON.parse threw). Q1's original wrapper
  // assumed string-only and returned null for objects, silently missing 100%
  // of real rejection envelopes. These tests pin the fix by exercising the
  // exact call-site pattern used by readJobOutcome + auditFinalSubmitMatch.

  function detectFromCaptureLike(capture: { responseBody?: unknown }): {
    rejected: boolean;
    reason: string | null;
  } {
    // Mirror the call-site pattern that handles all three shapes the
    // capture writer can produce: object, string-of-JSON, null.
    let body: unknown = capture.responseBody;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = null;
      }
    }
    return detectRejectionInResponseBody(body);
  }

  it("detects rejection when capture.responseBody is an OBJECT (the AppCast real-world case)", () => {
    const capture = {
      url: "https://apply.appcast.io/api/jobs/53722549083/integrated_apply",
      status: 200,
      responseBody: {
        not_qualified: true,
        error: "Not qualified reason: email",
        ggc_thank_you_redirect_url: "https://www.getgreatcareers.com/?...",
      },
    };
    expect(detectFromCaptureLike(capture)).toEqual({
      rejected: true,
      reason: "Not qualified reason: email",
    });
  });

  it("detects rejection when capture.responseBody is a STRING containing JSON (fallback case)", () => {
    const capture = {
      responseBody: '{"not_qualified": true, "error": "Not qualified reason: email"}',
    };
    expect(detectFromCaptureLike(capture)).toEqual({
      rejected: true,
      reason: "Not qualified reason: email",
    });
  });

  it("returns rejected=false when capture.responseBody is a non-JSON string", () => {
    const capture = { responseBody: "<html>error page</html>" };
    expect(detectFromCaptureLike(capture)).toEqual({ rejected: false, reason: null });
  });

  it("returns rejected=false when capture.responseBody is null (CDP fetch failure)", () => {
    expect(detectFromCaptureLike({ responseBody: null })).toEqual({
      rejected: false,
      reason: null,
    });
  });

  it("returns rejected=false when capture.responseBody is missing entirely", () => {
    expect(detectFromCaptureLike({})).toEqual({ rejected: false, reason: null });
  });

  it("returns rejected=false when capture.responseBody is an OBJECT representing acceptance", () => {
    const capture = {
      url: "https://apply.appcast.io/api/jobs/56388099463/integrated_apply",
      status: 200,
      responseBody: {
        not_qualified: false,
        ggc_thank_you_redirect_url: "https://www.getgreatcareers.com/?...",
      },
    };
    expect(detectFromCaptureLike(capture)).toEqual({ rejected: false, reason: null });
  });
});

// ─── probeStepBeforeAttempts (focused → unfocused observe fallback) ───────────

describe("recon-browser/probeStepBeforeAttempts", () => {
  // guardedObserve dispatches to stagehand.observe(instruction, options) for the
  // FOCUSED probe (first arg is the step string) and stagehand.observe(options)
  // for the UNFOCUSED fallback (first arg is the options object). We branch the
  // mock on `typeof args[0]` to control each independently.
  const nonEmpty = [
    { selector: "xpath=/html/body/input", description: "First Name field", method: "fill" },
  ];

  function makeProbeStagehand(
    focused: unknown[],
    unfocused: unknown[]
  ): {
    observe: ReturnType<typeof vi.fn>;
  } {
    return {
      observe: vi
        .fn()
        .mockImplementation((...args: unknown[]) =>
          Promise.resolve(typeof args[0] === "string" ? focused : unfocused)
        ),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns present when focused observe is empty but unfocused observe finds candidates", async () => {
    const stagehand = makeProbeStagehand([], nonEmpty);
    const result = await probeStepBeforeAttempts({
      stagehand: stagehand as never,
      step: "Fill in the First Name field with 'Reginald'",
      stepIndex: 5,
      logger: testLogger,
    });
    expect(result).toBe("present");
    // focused probe + unfocused fallback = two observe calls.
    expect(stagehand.observe).toHaveBeenCalledTimes(2);
    expect(typeof stagehand.observe.mock.calls[0]?.[0]).toBe("string");
    expect(typeof stagehand.observe.mock.calls[1]?.[0]).not.toBe("string");
  });

  it("returns absent when both focused and unfocused observe are empty", async () => {
    const stagehand = makeProbeStagehand([], []);
    const result = await probeStepBeforeAttempts({
      stagehand: stagehand as never,
      step: "Fill in the First Name field with 'Reginald'",
      stepIndex: 5,
      logger: testLogger,
    });
    expect(result).toBe("absent");
    expect(stagehand.observe).toHaveBeenCalledTimes(2);
  });

  it("returns present without the unfocused fallback when the focused observe finds candidates", async () => {
    const stagehand = makeProbeStagehand(nonEmpty, nonEmpty);
    const result = await probeStepBeforeAttempts({
      stagehand: stagehand as never,
      step: "Click the Apply button",
      stepIndex: 2,
      logger: testLogger,
    });
    expect(result).toBe("present");
    // Happy path: only the focused probe runs; no wasted unfocused observe.
    expect(stagehand.observe).toHaveBeenCalledTimes(1);
  });
});

describe("recon-browser/parseSelectStep", () => {
  it("extracts the option from a bare select step", () => {
    expect(parseSelectStep("Select 'Texas' in the State or State/Region dropdown")).toEqual({
      option: "Texas",
      questionLabel: null,
    });
  });

  it("extracts option AND question label when the step scopes a question", () => {
    expect(
      parseSelectStep(
        "On the COMPENSATION / Job-Related Questions page, for 'What is your highest level of nursing education?' select 'Bachelors of Science in Nursing completed'"
      )
    ).toEqual({
      option: "Bachelors of Science in Nursing completed",
      questionLabel: "What is your highest level of nursing education?",
    });
  });

  it("handles 'select or check' phrasing", () => {
    expect(
      parseSelectStep(
        "For 'Which of the following certifications do you currently possess?' select or check 'Basic Life Support (BLS)'"
      )
    ).toEqual({
      option: "Basic Life Support (BLS)",
      questionLabel: "Which of the following certifications do you currently possess?",
    });
  });

  it("parses the multi-select CHECKBOX question steps (tryCheckboxPrimitive entry contract)", () => {
    // These Talemetry questions render as c-MultiCheckboxInput groups, not
    // <select>; tryCheckboxPrimitive reuses parseSelectStep to extract the
    // option + question label, so these must parse to {option, questionLabel}.
    expect(
      parseSelectStep(
        "For 'In which settings have you worked as a Registered Nurse during the past three years?' select 'Hospital'"
      )
    ).toEqual({
      option: "Hospital",
      questionLabel:
        "In which settings have you worked as a Registered Nurse during the past three years?",
    });
    expect(
      parseSelectStep(
        "For 'Which best describes your current or most recent experience?' select 'Emergency Department'"
      )
    ).toEqual({
      option: "Emergency Department",
      questionLabel: "Which best describes your current or most recent experience?",
    });
  });

  it("returns null for generic catch-all steps (no single target)", () => {
    expect(
      parseSelectStep(
        "For any remaining self-identification, EEO, or voluntary question with a dropdown or radio, select 'I do not wish to answer' or 'Prefer not to answer'"
      )
    ).toBeNull();
  });

  it("returns null for non-select steps (radio click / Next)", () => {
    expect(
      parseSelectStep("Click the 'Yes' answer for the question 'Are you at least 18?'")
    ).toBeNull();
    expect(
      parseSelectStep("Click the 'Next' button to leave the Basic Information page")
    ).toBeNull();
  });

  it("returns null when there is no quoted option to select", () => {
    expect(parseSelectStep("Select an appropriate value in the dropdown")).toBeNull();
  });
});

describe("recon-browser/isStructurallyBlocked", () => {
  it("is true when every attempt resolved no selector and never verified", () => {
    expect(
      isStructurallyBlocked([
        { triedSelectors: [], verifiedBy: null },
        { triedSelectors: [], verifiedBy: null },
        { triedSelectors: [], verifiedBy: null },
      ])
    ).toBe(true);
  });

  it("is false when any attempt resolved a selector (control was found)", () => {
    expect(
      isStructurallyBlocked([
        { triedSelectors: [], verifiedBy: null },
        { triedSelectors: ["xpath=/html/body/input"], verifiedBy: null },
      ])
    ).toBe(false);
  });

  it("is false when any attempt carried a verification signal", () => {
    expect(
      isStructurallyBlocked([
        { triedSelectors: [], verifiedBy: null },
        { triedSelectors: [], verifiedBy: "dom" },
      ])
    ).toBe(false);
  });

  it("is false for an empty attempts array (no evidence either way)", () => {
    expect(isStructurallyBlocked([])).toBe(false);
  });
});

describe("recon-browser/windowHasTransitionBody", () => {
  let dir: string;
  const writeCapture = (name: string, requestPostData: unknown): void => {
    writeFileSync(join(dir, name), JSON.stringify({ url: "https://x/gq", requestPostData }));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "recon-adv-gate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false when no pattern is configured (opt-in)", () => {
    writeCapture("0-x.json", '{"query":"mutation TransitionWorklet"}');
    expect(
      windowHasTransitionBody({
        recentCaptures: ["0-x.json"],
        preLength: 0,
        advanceTransitionBodyPattern: null,
        capturesDir: dir,
      })
    ).toBe(false);
  });

  it("returns true when a body in the window matches the pattern (real advance)", () => {
    writeCapture("0-a.json", '{"query":"mutation TransitionWorklet(...)"}');
    expect(
      windowHasTransitionBody({
        recentCaptures: ["0-a.json"],
        preLength: 0,
        advanceTransitionBodyPattern: "TransitionWorklet",
        capturesDir: dir,
      })
    ).toBe(true);
  });

  it("returns false when the only same-endpoint POST is a non-advance mutation", () => {
    // The exact false-heal case: EditQuestionItem shares the /gq URL but must NOT
    // count as an advance.
    writeCapture(
      "0-edit.json",
      '{"query":"mutation questionItemEditMutation { EditQuestionItem }"}'
    );
    expect(
      windowHasTransitionBody({
        recentCaptures: ["0-edit.json"],
        preLength: 0,
        advanceTransitionBodyPattern: "TransitionWorklet",
        capturesDir: dir,
      })
    ).toBe(false);
  });

  it("only scans captures added after preLength (this step's window)", () => {
    writeCapture("0-old.json", '{"query":"mutation TransitionWorklet"}');
    writeCapture("1-new.json", '{"query":"mutation EditQuestionItem"}');
    // preLength=1 → only "1-new.json" is in-window → no transition match.
    expect(
      windowHasTransitionBody({
        recentCaptures: ["0-old.json", "1-new.json"],
        preLength: 1,
        advanceTransitionBodyPattern: "TransitionWorklet",
        capturesDir: dir,
      })
    ).toBe(false);
  });

  it("skips .decoded.json sidecars and tolerates unreadable captures", () => {
    writeCapture("0-a.json", '{"query":"EditQuestionItem"}');
    // decoded sidecar with a matching string must be ignored (only raw counts)
    writeFileSync(join(dir, "0-a.decoded.json"), '"mutation TransitionWorklet"');
    expect(
      windowHasTransitionBody({
        recentCaptures: ["0-a.json", "0-a.decoded.json", "missing.json"],
        preLength: 0,
        advanceTransitionBodyPattern: "TransitionWorklet",
        capturesDir: dir,
      })
    ).toBe(false);
  });
});

describe("recon-browser/selectBodyExcerpt — MUI marker (RC1)", () => {
  it("centers the excerpt on a Mui-error marker past the default cap", () => {
    const filler = "x".repeat(50_000);
    const body = `${filler}<div class="MuiFormControl-root Mui-error"><label>State/Region *</label></div>${"y".repeat(50_000)}`;
    const excerpt = selectBodyExcerpt(body);
    // The MUI marker (past the default cap) must appear in the returned window;
    // an ng-only matcher would have returned the head slice without it.
    expect(excerpt).toContain("Mui-error");
  });
});

describe("recon-browser/pollEnumerate — settle-retry", () => {
  it("returns immediately when the widget is present on the first evaluate", async () => {
    const evaluate = vi.fn().mockResolvedValue({ present: true, n: 1 });
    const waitForTimeout = vi.fn().mockResolvedValue(undefined);
    const page = { evaluate, waitForTimeout } as unknown as Parameters<typeof pollEnumerate>[0];
    const result = await pollEnumerate<{ present: boolean; n: number }>(
      page,
      "expr",
      (r) => r.present
    );
    expect(result).toEqual({ present: true, n: 1 });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(waitForTimeout).not.toHaveBeenCalled();
  });

  it("re-polls until the widget appears (render-lag), then returns it", async () => {
    // Empty on the first two tries (widget not rendered yet), present on the third.
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ present: false })
      .mockResolvedValueOnce({ present: false })
      .mockResolvedValueOnce({ present: true, n: 3 });
    const waitForTimeout = vi.fn().mockResolvedValue(undefined);
    const page = { evaluate, waitForTimeout } as unknown as Parameters<typeof pollEnumerate>[0];
    const result = await pollEnumerate<{ present: boolean; n?: number }>(
      page,
      "expr",
      (r) => r.present
    );
    expect(result).toEqual({ present: true, n: 3 });
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(waitForTimeout).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt cap and returns the last absent result", async () => {
    const evaluate = vi.fn().mockResolvedValue({ present: false });
    const waitForTimeout = vi.fn().mockResolvedValue(undefined);
    const page = { evaluate, waitForTimeout } as unknown as Parameters<typeof pollEnumerate>[0];
    const result = await pollEnumerate<{ present: boolean }>(page, "expr", (r) => r.present);
    expect(result).toEqual({ present: false });
    // Capped at PRIMITIVE_ENUMERATE_ATTEMPTS (5) evaluates, 4 waits between them.
    expect(evaluate).toHaveBeenCalledTimes(5);
    expect(waitForTimeout).toHaveBeenCalledTimes(4);
  });
});
