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
import { CALL_TYPE_RECON_REPHRASE } from "@/lib/telemetry/call-types";
import {
  dedupeConsecutiveIdentical,
  denormalizeStep,
  describeAttemptEffectSignals,
  extractSubmitFailureEvidence,
  findRecentBackendError,
  findRecentPageTransition,
  hasBillingErrorBeenLogged,
  type InvalidFormControl,
  isReplanCycle,
  isSubmitRevealedInvalid,
  logBillingErrorIfPresent,
  type NormalizedStep,
  narrowInvalidFormControl,
  persistReplannedFlow,
  type ReplanEvent,
  readFailureDumpEvidence,
  renderUnfocusedObserve,
  rephraseWithLLM,
  replanRemainingFlow,
  resetBillingErrorFlagForTests,
  shouldSkipTechnique,
  summarizeReplanFailureKinds,
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

  it("returns empty fields when the dump file is missing", () => {
    const result = readFailureDumpEvidence(join(tmpDir, "does-not-exist.json"));
    expect(result).toEqual({
      bodyExcerpt: "",
      unfocusedList: "",
      invalidFieldList: "",
      errorTextList: "",
      recentFailureReasons: [],
    });
  });

  it("flags fields with ng-invalid class and surfaces the field label", () => {
    // Angular reactive-form snippet: a labelled input with the ng-invalid +
    // ng-touched class signature that means "user interacted, field is empty
    // / wrong format." This is the smoking-gun pattern the replan prompt was
    // missing.
    const body = `<form class="ng-valid">
      <li class="question ng-invalid ng-dirty ng-touched">
        <label>County</label>
        <input class="ng-invalid ng-dirty ng-touched" value=""/>
      </li>
      <li class="question ng-valid">
        <label>State</label>
        <input class="ng-valid" value="TX"/>
      </li>
    </form>`;
    writeFileSync(dumpPath, JSON.stringify({ bodyOuterHtml: body, attempts: [] }));
    const result = readFailureDumpEvidence(dumpPath);
    // Signal contract: County (the invalid field) must be present with its
    // ng-invalid class fingerprint. The 600-char following-window may bleed
    // sibling text in by design — fine for an advisory LLM prompt section.
    expect(result.invalidFieldList).toContain("County");
    expect(result.invalidFieldList).toContain("ng-invalid");
  });

  it("does not flag a ng-valid form root just because its subtree contains invalid descendants", () => {
    // Regression guard: the prior balanced-tag regex matched the outer
    // <form> first and attributed the entire subtree to its ng-valid class,
    // wrongly listing nothing as invalid. The opening-tag scan should
    // produce at least one invalid entry from the inner ng-invalid <li>.
    const body = `<form class="ng-valid">
      <li class="question ng-invalid"><label>County</label></li>
    </form>`;
    writeFileSync(dumpPath, JSON.stringify({ bodyOuterHtml: body, attempts: [] }));
    const result = readFailureDumpEvidence(dumpPath);
    expect(result.invalidFieldList.length).toBeGreaterThan(0);
    expect(result.invalidFieldList).toContain("County");
  });

  it("extracts visible error message text from error-class containers", () => {
    const body = `<form>
      <div class="error-message">This field is required.</div>
      <div class="mat-error">Please provide correct phone number.</div>
    </form>`;
    writeFileSync(dumpPath, JSON.stringify({ bodyOuterHtml: body, attempts: [] }));
    const result = readFailureDumpEvidence(dumpPath);
    expect(result.errorTextList).toContain("This field is required");
    expect(result.errorTextList).toContain("Please provide correct phone number");
  });

  it("ignores text inside an unrelated class when no error-pattern marker is present", () => {
    const body = `<div class="some-other-class">Job title at Encompass Health</div>`;
    writeFileSync(dumpPath, JSON.stringify({ bodyOuterHtml: body, attempts: [] }));
    const result = readFailureDumpEvidence(dumpPath);
    expect(result.errorTextList).toBe("");
  });

  it("recentFailureReasons surfaces the trailing 5 attempt errorMessage values", () => {
    const attempts = Array.from({ length: 8 }, (_, i) => ({
      errorMessage: `attempt-${i + 1}: reason`,
    }));
    writeFileSync(dumpPath, JSON.stringify({ bodyOuterHtml: null, attempts }));
    const result = readFailureDumpEvidence(dumpPath);
    expect(result.recentFailureReasons).toEqual([
      "attempt-4: reason",
      "attempt-5: reason",
      "attempt-6: reason",
      "attempt-7: reason",
      "attempt-8: reason",
    ]);
  });

  it("skips attempts with null/empty errorMessage when collecting reasons", () => {
    const attempts = [
      { errorMessage: "real failure A" },
      { errorMessage: null },
      { errorMessage: "" },
      { errorMessage: "real failure B" },
    ];
    writeFileSync(dumpPath, JSON.stringify({ bodyOuterHtml: null, attempts }));
    const result = readFailureDumpEvidence(dumpPath);
    expect(result.recentFailureReasons).toEqual(["real failure A", "real failure B"]);
  });

  it("caps both extracted lists at the EVIDENCE_LIST_CAP", () => {
    // Build a body with 20 invalid fields. Cap is 12 by current contract.
    const items = Array.from(
      { length: 20 },
      (_, i) => `<li class="ng-invalid"><label>Field-${i}</label></li>`
    ).join("");
    const body = `<form>${items}</form>`;
    writeFileSync(dumpPath, JSON.stringify({ bodyOuterHtml: body, attempts: [] }));
    const result = readFailureDumpEvidence(dumpPath);
    const lines = result.invalidFieldList.split("\n");
    expect(lines.length).toBeLessThanOrEqual(12);
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

describe("recon-browser/renderUnfocusedObserve", () => {
  // Helper to build a minimal Action-shaped object for testing.
  const make = (description: string): { description: string; selector: string } => ({
    description,
    selector: `xpath=//placeholder/${description.replace(/\s+/g, "-")}`,
  });

  it("returns empty string for empty input", () => {
    expect(renderUnfocusedObserve([])).toBe("");
  });

  it("renders entries as numbered description + selector lines", () => {
    const observations = [make("First Name input"), make("Submit button")];
    const out = renderUnfocusedObserve(observations);
    expect(out).toContain("1. First Name input");
    expect(out).toContain("2. Submit button");
  });

  it("prioritizes entries with 'modal' in description to the top regardless of position", () => {
    // Build a list with 80 dummy entries; place modal entries at indices 70-77.
    const observations = [
      ...Array.from({ length: 70 }, (_, i) => make(`form field ${i}`)),
      make("Save button in education modal (first modal)"),
      make("Close button in education modal (first modal)"),
      make("Degree dropdown in education modal (first modal)"),
      make("Education level dropdown in education modal (first modal)"),
      make("Save button in education modal (second modal)"),
      make("Close button in education modal (second modal)"),
      make("Degree dropdown in education modal (second modal)"),
      make("Education level dropdown in education modal (second modal)"),
    ];
    const out = renderUnfocusedObserve(observations);
    expect(out).toContain("Save button in education modal (first modal)");
    expect(out).toContain("Save button in education modal (second modal)");
    expect(out.indexOf("Save button in education modal (first modal)")).toBeLessThan(
      out.indexOf("form field 0")
    );
  });

  it("also catches 'dialog', 'popup', 'overlay', 'drawer' as modal-shaped UI", () => {
    const observations = [
      ...Array.from({ length: 30 }, (_, i) => make(`form field ${i}`)),
      make("Save button in confirmation dialog"),
      make("Close button in popup window"),
      make("Cancel button in side overlay"),
      make("Submit button in nav drawer"),
    ];
    const out = renderUnfocusedObserve(observations);
    expect(out).toContain("confirmation dialog");
    expect(out).toContain("popup window");
    expect(out).toContain("side overlay");
    expect(out).toContain("nav drawer");
  });

  it("caps the rendered list at the default cap (30)", () => {
    const observations = Array.from({ length: 60 }, (_, i) => make(`item ${i}`));
    const out = renderUnfocusedObserve(observations);
    const lines = out.split("\n");
    expect(lines.length).toBeLessThanOrEqual(30);
  });

  it("honors an explicit cap override", () => {
    const observations = Array.from({ length: 60 }, (_, i) => make(`item ${i}`));
    const out = renderUnfocusedObserve(observations, 5);
    const lines = out.split("\n");
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it("modal matching is case-insensitive", () => {
    const observations = [make("Submit button"), make("Save action inside MODAL container")];
    const out = renderUnfocusedObserve(observations);
    expect(out.indexOf("MODAL container")).toBeLessThan(out.indexOf("Submit button"));
  });
});

describe("recon-browser/extractSubmitFailureEvidence", () => {
  let tmpDir: string;
  const submitRx = /^https:\/\/example\.com\/api\/apply$/;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-submit-fail-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCapture(filename: string, body: object): void {
    writeFileSync(join(tmpDir, filename), JSON.stringify(body));
  }

  it("returns empty when the submit pattern is null", () => {
    expect(extractSubmitFailureEvidence(["capture-1.json"], null, tmpDir)).toBe("");
  });

  it("returns empty when no recent captures match the submit endpoint", () => {
    writeCapture("capture-1.json", {
      url: "https://example.com/api/other",
      status: 200,
      responseBody: { ok: true },
    });
    expect(extractSubmitFailureEvidence(["capture-1.json"], submitRx, tmpDir)).toBe("");
  });

  it("returns empty when the submit-endpoint capture succeeded (2xx)", () => {
    writeCapture("capture-1.json", {
      url: "https://example.com/api/apply",
      status: 200,
      responseBody: { ok: true },
    });
    expect(extractSubmitFailureEvidence(["capture-1.json"], submitRx, tmpDir)).toBe("");
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
    const out = extractSubmitFailureEvidence(["capture-1.json"], submitRx, tmpDir);
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
    const out = extractSubmitFailureEvidence(["capture-1.json"], submitRx, tmpDir);
    expect(out).toContain("firstName: must be present");
  });

  it("falls back to top-level { message } when no field errors are present", () => {
    writeCapture("capture-1.json", {
      url: "https://example.com/api/apply",
      status: 500,
      responseBody: { message: "Internal server error" },
    });
    const out = extractSubmitFailureEvidence(["capture-1.json"], submitRx, tmpDir);
    expect(out).toContain("Internal server error");
  });

  it("skips missing capture files silently", () => {
    expect(extractSubmitFailureEvidence(["missing.json"], submitRx, tmpDir)).toBe("");
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
  const submitRx = /^https:\/\/example\.com\/api\/apply$/;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-anyfourxx-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCapture(filename: string, body: object): void {
    writeFileSync(join(tmpDir, filename), JSON.stringify(body));
  }

  it("strict mode (default) ignores 4xx whose URL does not match the pattern", () => {
    writeCapture("c1.json", {
      url: "https://example.com/api/errors",
      status: 422,
      responseBody: { errors: [{ field: "email", message: "Invalid format" }] },
    });
    const out = extractSubmitFailureEvidence(["c1.json"], submitRx, tmpDir);
    expect(out).toBe("");
  });

  it("any-4xx mode parses a 4xx whose URL does NOT match the configured pattern", () => {
    writeCapture("c1.json", {
      url: "https://example.com/api/errors",
      status: 422,
      responseBody: { errors: [{ field: "email", message: "Invalid format" }] },
    });
    const out = extractSubmitFailureEvidence(["c1.json"], null, tmpDir, "any-4xx");
    expect(out).toContain("422 https://example.com/api/errors");
    expect(out).toContain("email: Invalid format");
  });

  it("any-4xx mode still requires status >= 400 (ignores 2xx)", () => {
    writeCapture("c1.json", {
      url: "https://example.com/api/track",
      status: 200,
      responseBody: { ok: true },
    });
    const out = extractSubmitFailureEvidence(["c1.json"], null, tmpDir, "any-4xx");
    expect(out).toBe("");
  });

  it("any-4xx mode returns empty when no 4xx exists in the window", () => {
    writeCapture("c1.json", {
      url: "https://example.com/api/save",
      status: 200,
      responseBody: { ok: true },
    });
    const out = extractSubmitFailureEvidence(["c1.json"], null, tmpDir, "any-4xx");
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
    const prompt = calls[0]?.userContent ?? "";
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
    const prompt = calls[0]?.userContent ?? "";
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
    const prompt = calls[0]?.userContent ?? "";
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
    const prompt = calls[0]?.userContent ?? "";
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
  const submitRx = /^https:\/\/example\.com\/api\/apply$/;

  it("returns null when the submit pattern is null", () => {
    expect(
      findRecentBackendError({
        recentCaptureMeta: [{ method: "POST", status: 500, url: "https://example.com/api/apply" }],
        preMetaLength: 0,
        submitEndpointPattern: null,
      })
    ).toBeNull();
  });

  it("returns null when the window is empty", () => {
    expect(
      findRecentBackendError({
        recentCaptureMeta: [],
        preMetaLength: 0,
        submitEndpointPattern: submitRx,
      })
    ).toBeNull();
  });

  it("returns null when only earlier-step captures exist", () => {
    expect(
      findRecentBackendError({
        recentCaptureMeta: [{ method: "POST", status: 500, url: "https://example.com/api/apply" }],
        preMetaLength: 1,
        submitEndpointPattern: submitRx,
      })
    ).toBeNull();
  });

  it("returns the matched URL for a 5xx hitting the submit endpoint", () => {
    expect(
      findRecentBackendError({
        recentCaptureMeta: [{ method: "POST", status: 500, url: "https://example.com/api/apply" }],
        preMetaLength: 0,
        submitEndpointPattern: submitRx,
      })
    ).toBe("https://example.com/api/apply");
  });

  it("ignores 5xx on URLs that do not match the submit pattern (analytics noise)", () => {
    expect(
      findRecentBackendError({
        recentCaptureMeta: [
          { method: "POST", status: 503, url: "https://googleads.g.doubleclick.net/pixel" },
        ],
        preMetaLength: 0,
        submitEndpointPattern: submitRx,
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
        submitEndpointPattern: submitRx,
      })
    ).toBeNull();
  });

  it("matches any 5xx code (500-599) on the submit endpoint", () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(
        findRecentBackendError({
          recentCaptureMeta: [{ method: "POST", status, url: "https://example.com/api/apply" }],
          preMetaLength: 0,
          submitEndpointPattern: submitRx,
        })
      ).toBe("https://example.com/api/apply");
    }
  });
});
