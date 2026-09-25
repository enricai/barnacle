/**
 * End-to-end acceptance regression for the OTHER `submitStep` carry-forward
 * call site in the replan splice path (recon-browser.ts, ~3301-3318): when
 * every replan bridge step duplicates `originalRemaining[0]` and is filtered
 * out by `filterReplanDuplicatingNextAuthored`, `originalRemaining[0]` itself
 * becomes the resume target and `patchedOriginalRemaining` re-applies the
 * failed step's flags there. That gate is strictly
 * `step.captchaGated || step.submitStep` — it must never widen to also
 * consult the resume target's OWN instruction text via
 * `isSubmitShapedInstructionText`, the way the sibling bridge-step call site
 * (covered by `recon-browser.replan-plain-fill-submitstep-not-inherited-acceptance.test.ts`)
 * now does via `seedSubmitStepFromOwnInstructionText`. Drives `main()` for
 * real (only `createBrowserSession` and the replan LLM call are stubbed)
 * with a failed step that carries no `submitStep`/`captchaGated` flags, a
 * replan LLM response whose sole bridge step duplicates the quoted label of
 * `originalRemaining[0]` (so the filter drops it and the tagged bridge list
 * is empty), and `originalRemaining[0]`'s own instruction text is
 * submit-shaped. Asserts the `executeStepWithHealing` call for the resumed
 * `originalRemaining[0]` step still carries `submitStep: false`.
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
const FAILED_STEP = "Fill in the 'Discount Code' field with '10OFF'";
const RESUME_TARGET_STEP = "Click 'Save and Continue' to proceed";
// Duplicates the resume target's quoted label so
// filterReplanDuplicatingNextAuthored drops it, leaving the tagged bridge
// list empty and originalRemaining[0] as the resume target.
const DUPLICATE_BRIDGE_STEP = "Try 'Save and Continue' again now that the code is valid";

function flowArgv(): string[] {
  return [
    "node",
    "recon-browser.ts",
    "--url",
    BASE_URL,
    "--flow",
    JSON.stringify([{ step: FAILED_STEP }, { step: RESUME_TARGET_STEP }]),
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

describe("recon-browser/main — resume-target carry-forward stays gated on step.submitStep only", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-resume-target-"));
    process.env.RECON_RUN_ID = "20260925-000000-resumetarget";
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

  it("does not seed submitStep:true onto the resumed originalRemaining[0] from its own submit-shaped text when the failed step never had submitStep set", async () => {
    const { stagehand } = makeFakePage();
    createBrowserSessionStub.mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    messagesParseStub.mockResolvedValueOnce(replanResponse(DUPLICATE_BRIDGE_STEP));

    executeStepWithHealingStub.mockImplementation(async (args: { step: string }) => {
      if (args.step === FAILED_STEP) {
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
    // Only the failed step and the resumed originalRemaining[0] ever run —
    // the duplicate bridge step is filtered out before splice.
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);
    expect(
      executeStepWithHealingStub.mock.calls.some(
        ([args]) => (args as { step: string }).step === DUPLICATE_BRIDGE_STEP
      )
    ).toBe(false);

    const resumeCallArgs = executeStepWithHealingStub.mock.calls.find(
      ([args]) => (args as { step: string }).step === RESUME_TARGET_STEP
    )?.[0] as { step: string; submitStep: boolean } | undefined;

    expect(resumeCallArgs).toBeDefined();
    // The resume target's own instruction text is submit-shaped, but the
    // failed step never had submitStep/captchaGated set — this call site
    // must NOT widen its gate to isSubmitShapedInstructionText.
    expect(resumeCallArgs?.submitStep).toBe(false);
  });
});
