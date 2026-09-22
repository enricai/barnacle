/**
 * End-to-end acceptance coverage for the fixed replan-splice `submitStep`
 * carry-forward (`applyFailedStepFlagsToResumingBridgeStep`, recon-browser.ts):
 * a solo replan bridge step that is a plain, unrelated field fill must NOT
 * inherit `submitStep:true` from the failed step it resumes after, since
 * running the submit-only cascade validation against a step that never
 * submits anything blocks the flow. Drives `main()` for real (only
 * `createBrowserSession` and the replan LLM call are stubbed) with a
 * `submitStep: true` step that fails its cascade, has the replan LLM propose
 * a single plain field-fill bridge step (no quoted-label overlap with the
 * failed step, no compound clause, not submit-shaped wording), and asserts
 * the next `executeStepWithHealing` call — for the spliced-in bridge step —
 * carries `submitStep: false`. A sibling case pins the inverse: a genuinely
 * submit-shaped solo bridge step still resumes with `submitStep: true`, so
 * the fix does not overcorrect into never inheriting the flag at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
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

// The replan dispatcher drives the raw Anthropic SDK client (not the `ai`
// package) via buildAnthropicClient — stub the same seam the acceptance
// tests for the replan budget/verdict paths use, so the LLM's raw output is
// what the splice path has to work with.
const { messagesParseStub } = vi.hoisted(() => ({ messagesParseStub: vi.fn() }));
vi.mock("@/lib/llm/anthropic-client", () => ({
  buildAnthropicClient: () => ({ messages: { parse: messagesParseStub } }),
  buildRephraseModel: () => null,
}));

import { StepVerificationError } from "@/scraper/errors";
import { main } from "@/scripts/recon-browser";

const BASE_URL = "https://portal.example.net/app/order";
const ORIGINAL_STEP = "Click the 'Submit' button";

function flowArgv(): string[] {
  return [
    "node",
    "recon-browser.ts",
    "--url",
    BASE_URL,
    "--flow",
    JSON.stringify([{ step: ORIGINAL_STEP, submitStep: true }]),
  ];
}

function replanResponse(bridgeStep: string): {
  parsed_output: { outcome: string; steps: string[] };
  content: { type: string; text: string }[];
  usage: { input_tokens: number; output_tokens: number };
} {
  return {
    parsed_output: { outcome: "replan", steps: [bridgeStep] },
    content: [{ type: "text", text: "" }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function makeFakePage(): { page: Page; stagehand: Stagehand } {
  const session = { on: (): void => {}, off: (): void => {} };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: (): string => BASE_URL,
    title: vi.fn().mockResolvedValue("Order"),
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

describe("recon-browser/main — submitStep is not blindly inherited by a plain-fill replan bridge", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-replan-plainfill-"));
    process.env.RECON_RUN_ID = "20260922-000000-replanplainfill";
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
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
    executeStepWithHealingStub.mockReset();
    guardedObserveStub.mockReset();
    messagesParseStub.mockReset();
  });

  it("does not carry submitStep:true onto a solo plain-fill bridge step unrelated to the failed control", async () => {
    const BRIDGE_STEP = "Fill the 'Company Name' field with 'Acme Corp'";

    const { stagehand } = makeFakePage();
    createBrowserSessionStub.mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    messagesParseStub.mockResolvedValueOnce(replanResponse(BRIDGE_STEP));

    executeStepWithHealingStub.mockImplementation(async (args: { step: string }) => {
      if (args.step === ORIGINAL_STEP) {
        throw new StepVerificationError(
          "step failed verification: cascade exhausted",
          "cascade-exhausted"
        );
      }
      return "completed";
    });

    process.argv = flowArgv();

    await expect(main()).resolves.toBeUndefined();

    expect(messagesParseStub).toHaveBeenCalledTimes(1);
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);

    const bridgeCallArgs = executeStepWithHealingStub.mock.calls.find(
      ([args]) => (args as { step: string }).step === BRIDGE_STEP
    )?.[0] as { step: string; submitStep: boolean } | undefined;

    expect(bridgeCallArgs).toBeDefined();
    // Plain field fill unrelated to the failed "Submit" control must not run
    // the submit-only cascade validation.
    expect(bridgeCallArgs?.submitStep).toBe(false);
  });

  it("still resumes with submitStep:true when the solo bridge step is itself genuinely submit-shaped", async () => {
    const BRIDGE_STEP = "Click 'Save and Continue' to proceed with the order";

    process.argv = ["node", "vitest"];
    vi.resetModules();
    const { main } = await import("@/scripts/recon-browser.js");

    const { stagehand } = makeFakePage();
    createBrowserSessionStub.mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    messagesParseStub.mockResolvedValueOnce(replanResponse(BRIDGE_STEP));

    executeStepWithHealingStub.mockImplementation(async (args: { step: string }) => {
      if (args.step === ORIGINAL_STEP) {
        throw new StepVerificationError(
          "step failed verification: cascade exhausted",
          "cascade-exhausted"
        );
      }
      return "completed";
    });

    process.argv = flowArgv();

    await expect(main()).resolves.toBeUndefined();

    expect(messagesParseStub).toHaveBeenCalledTimes(1);
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);

    const bridgeCallArgs = executeStepWithHealingStub.mock.calls.find(
      ([args]) => (args as { step: string }).step === BRIDGE_STEP
    )?.[0] as { step: string; submitStep: boolean } | undefined;

    expect(bridgeCallArgs).toBeDefined();
    // Guards against overcorrection: a bridge step that is itself
    // submit-shaped must still resume the submit-only cascade validation.
    expect(bridgeCallArgs?.submitStep).toBe(true);
  });
});
