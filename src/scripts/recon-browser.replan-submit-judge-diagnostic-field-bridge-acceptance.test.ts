/**
 * End-to-end coverage for root cause 2's fix, driven through `main()` the
 * same way as `recon-browser.replan-captchagated-flag-retention.test.ts`
 * (only `createBrowserSession`, `executeStepWithHealing`, and the replan
 * Anthropic client are stubbed).
 *
 * The merged fix (bugfix-003/bugfix-004) is a prompt-level directive, not a
 * deterministic bypass of the `isReplanReproposingFailedStep` no-progress
 * guard: `extractSubmitJudgeRequiredFields` parses the submit-judge's named
 * still-required fields out of the failure dump and `replanRemainingFlow`
 * interpolates a STILL-REQUIRED FIELDS section instructing the replan LLM to
 * emit one fill step per field instead of re-proposing the failed step. The
 * guard itself is left untouched as the safety net for diagnostics that name
 * no fields at all. This file proves the fix's actual, reachable effect: a
 * replan LLM response that follows the directive (fills the named fields)
 * clears the failed step without ever tripping the guard, while a diagnostic
 * that names no fields still hits the pre-existing abort unchanged.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config", () => ({
  config: {
    scraper: {
      useBedrock: false,
      anthropicApiKey: "test-key",
      model: "anthropic/claude-sonnet-4-6",
      proxyType: "residential",
      steelSessionTimeoutMs: 30000,
      frameReadyTimeoutMs: 20_000,
      frameDocumentReadyTimeoutMs: 5_000,
      frameEvaluateTimeoutMs: 30_000,
      maxCascadeReplans: 5,
      maxProbeReplans: 5,
      maxTransportRetries: 1,
    },
    telemetry: {
      callsNdjsonPath: ".barnacle/calls.ndjson",
    },
  },
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));
const { createBrowserSessionStub } = vi.hoisted(() => ({
  createBrowserSessionStub: vi.fn(),
}));
vi.mock("@/scraper/session", () => ({ createBrowserSession: createBrowserSessionStub }));
vi.mock("@/scraper/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/errors")>();
  return { ...actual };
});

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

const { generateObjectStub } = vi.hoisted(() => ({ generateObjectStub: vi.fn() }));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateObject: generateObjectStub,
  };
});

const { executeStepWithHealingStub } = vi.hoisted(() => ({
  executeStepWithHealingStub: vi.fn(),
}));
vi.mock("@/scraper/flow-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/flow-runner")>();
  return {
    ...actual,
    executeStepWithHealing: executeStepWithHealingStub,
  };
});

const { guardedObserveStub } = vi.hoisted(() => ({ guardedObserveStub: vi.fn() }));
vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: guardedObserveStub,
  };
});

const { messagesParseStub } = vi.hoisted(() => ({ messagesParseStub: vi.fn() }));
vi.mock("@/lib/llm/anthropic-client", () => ({
  buildAnthropicClient: () => ({ messages: { parse: messagesParseStub } }),
  buildRephraseModel: () => null,
}));

import { StepVerificationError } from "@/scraper/errors";
import { main } from "@/scripts/recon-browser";

const BASE_URL = "https://portal.example.net/app/checkout";
const ORIGINAL_STEP = "Click the 'Place Order' button";

function flowArgv(): string[] {
  return [
    "node",
    "recon-browser.ts",
    "--url",
    BASE_URL,
    "--flow",
    JSON.stringify([{ step: ORIGINAL_STEP }]),
  ];
}

/**
 * `readFailureDumpEvidence` fans out to the invalid-field and error-message
 * Haiku judges (distinguished by their system-prompt text) before the replan
 * call itself lands — branch on that text the same way bugfix-004's own unit
 * test does, so those judge calls resolve to empty verdicts instead of
 * consuming the replan-call mock slot.
 */
function makeReplanClient(replanSteps: string[]): {
  messages: { parse: typeof messagesParseStub };
} {
  messagesParseStub.mockImplementation(async ({ system }: { system?: string }) => {
    const parsed_output = system?.includes("invalid-field detector")
      ? { fields: [] }
      : system?.includes("error-message extractor")
        ? { messages: [] }
        : { outcome: "replan", steps: replanSteps };
    return {
      parsed_output,
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 100, output_tokens: 5 },
    };
  });
  return { messages: { parse: messagesParseStub } };
}

function makeFakePage(): { page: Page; stagehand: Stagehand } {
  const session = { on: (): void => {}, off: (): void => {} };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: (): string => BASE_URL,
    title: vi.fn().mockResolvedValue("Checkout"),
    evaluate: vi.fn().mockResolvedValue(10_000),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    frames: vi.fn().mockReturnValue([]),
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ cookies: [] }),
  } as unknown as Page;
  const stagehand = {
    context: { awaitActivePage: async (): Promise<Page> => page },
  } as unknown as Stagehand;
  return { page, stagehand };
}

describe("recon-browser/main — submit-judge-named still-required fields drive a replan bridge instead of the no-progress abort", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;
  let tmpDumpDir: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-replan-fieldbridge-"));
    tmpDumpDir = mkdtempSync(join(tmpdir(), "recon-browser-replan-fieldbridge-dump-"));
    process.env.RECON_RUN_ID = "20260922-000000-replanfieldbridge";
    process.env.RECON_OUT_DIR = runsRoot;
    executeStepWithHealingStub.mockReset();
    guardedObserveStub.mockReset();
    guardedObserveStub.mockResolvedValue([]);
    messagesParseStub.mockReset();
    generateObjectStub.mockReset();
    createBrowserSessionStub.mockReset();
    loggerStub.info.mockClear();
    loggerStub.warn.mockClear();
    loggerStub.error.mockClear();
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    rmSync(tmpDumpDir, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
    executeStepWithHealingStub.mockReset();
    guardedObserveStub.mockReset();
    messagesParseStub.mockReset();
  });

  it("proceeds past the failed step via named-field fill bridge steps instead of aborting, when the submit-judge names still-required fields", async () => {
    const dumpPath = join(tmpDumpDir, "step-failure.json");
    writeFileSync(
      dumpPath,
      JSON.stringify({
        bodyOuterHtml: null,
        attempts: [
          {
            errorMessage:
              "submit-judge-rejected: Form still displays validation errors (Shipping Method, Gift Wrap fields) with an 'Errors Found' section visible; no submission occurred",
          },
        ],
      })
    );

    const FILL_STEP_A = "Fill in the Shipping Method field";
    const FILL_STEP_B = "Fill in the Gift Wrap field";
    makeReplanClient([FILL_STEP_A, FILL_STEP_B]);

    const { stagehand } = makeFakePage();
    createBrowserSessionStub.mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    executeStepWithHealingStub.mockImplementation(async (args: { step: string }) => {
      if (args.step === ORIGINAL_STEP) {
        throw new StepVerificationError(
          `step failed verification: cascade exhausted; see ${dumpPath}`,
          "cascade-exhausted"
        );
      }
      return "completed";
    });

    process.argv = flowArgv();

    await expect(main()).resolves.toBeUndefined();

    // The no-progress guard never fired: no "no new bridge" abort was
    // thrown or logged.
    const abortLogged = loggerStub.error.mock.calls.some((call: unknown[]) =>
      String(call[0]).includes("no new bridge")
    );
    expect(abortLogged).toBe(false);

    // The replan produced fill steps for the named fields, and both ran.
    const executedSteps = executeStepWithHealingStub.mock.calls.map(
      ([args]) => (args as { step: string }).step
    );
    expect(executedSteps).toContain(FILL_STEP_A);
    expect(executedSteps).toContain(FILL_STEP_B);
    // The failed step's second cascade attempt never happened — the bridge
    // replaced it rather than re-proposing it.
    expect(executedSteps.filter((s) => s === ORIGINAL_STEP)).toHaveLength(1);
  });

  it("still aborts with the no-progress guard when the diagnostic names no fields (regression guard preserved)", async () => {
    process.argv = ["node", "vitest"];
    vi.resetModules();
    const { main: freshMain } = await import("@/scripts/recon-browser.js");

    const dumpPath = join(tmpDumpDir, "step-failure-no-fields.json");
    writeFileSync(
      dumpPath,
      JSON.stringify({
        bodyOuterHtml: null,
        attempts: [{ errorMessage: "selector not found: button[type=submit]" }],
      })
    );

    // No fields named in the diagnostic, so nothing directs the LLM away
    // from re-proposing the step that just failed — the mocked replan
    // response reflects exactly that (the guard's actual trigger).
    makeReplanClient([ORIGINAL_STEP]);

    const { stagehand } = makeFakePage();
    createBrowserSessionStub.mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    executeStepWithHealingStub.mockImplementation(async (args: { step: string }) => {
      if (args.step === ORIGINAL_STEP) {
        throw new StepVerificationError(
          `step failed verification: cascade exhausted; see ${dumpPath}`,
          "cascade-exhausted"
        );
      }
      return "completed";
    });

    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      BASE_URL,
      "--flow",
      JSON.stringify([{ step: ORIGINAL_STEP }]),
    ];

    await expect(freshMain()).rejects.toThrow(/no new bridge/);

    const abortLogged = loggerStub.error.mock.calls.some((call: unknown[]) =>
      String(call[0]).includes("no new bridge")
    );
    expect(abortLogged).toBe(true);
  });
});
