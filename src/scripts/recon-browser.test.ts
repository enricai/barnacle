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
  dedupeConsecutiveIdentical,
  denormalizeStep,
  type InvalidFormControl,
  type NormalizedStep,
  narrowInvalidFormControl,
  persistReplannedFlow,
  type ReplanEvent,
  readFailureDumpEvidence,
  renderUnfocusedObserve,
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
      }
    );

    const prompt = calls[0]?.userContent ?? "";
    expect(prompt).toContain("FORM FIELDS CURRENTLY MARKED INVALID");
    expect(prompt).toContain("Legal First Name");
    expect(prompt).toContain("VISIBLE ERROR / REQUIRED-FIELD MESSAGES");
    expect(prompt).toContain("This field is required");
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
