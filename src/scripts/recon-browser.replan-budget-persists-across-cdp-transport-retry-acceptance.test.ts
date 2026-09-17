/**
 * Regression coverage for bugfix-001: `probeReplansUsed` / `cascadeReplansUsed`
 * lived inside `runFlowAttempt()`'s closure, so a CdpTransportClosedError-
 * triggered retry on a fresh session (`withScraperRetry` re-invoking
 * `runFlowAttempt()`) reset both counters to 0 — silently doubling the
 * effective cascade-replan budget across sessions instead of sharing one
 * bounded budget for the whole run. Fix hoists both `let`s to main()'s
 * scope so a fresh session continues consuming the SAME shared budget.
 * Mirrors the main()-driving harness in
 * recon-browser.cdp-transport-closed-mid-flow.test.ts.
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
      maxCascadeReplans: 1,
      maxProbeReplans: 5,
      maxTransportRetries: 3,
    },
    telemetry: {
      callsNdjsonPath: ".barnacle/calls.ndjson",
    },
  },
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));
vi.mock("@/scraper/session", () => ({ createBrowserSession: vi.fn() }));
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

// guardedObserve is replan's first async call — stubbing it to an empty
// candidate list keeps the replan dispatcher cheap without needing to drive
// the real stagehand.observe() path.
const { guardedObserveStub } = vi.hoisted(() => ({ guardedObserveStub: vi.fn() }));
vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: guardedObserveStub,
  };
});

// A real Anthropic client is never constructed — replanRemainingFlow only
// needs `client.messages.parse`, so buildAnthropicClient returns a minimal
// stand-in with that one method stubbed.
const { messagesParseStub } = vi.hoisted(() => ({ messagesParseStub: vi.fn() }));
vi.mock("@/lib/llm/anthropic-client", () => ({
  buildAnthropicClient: () => ({ messages: { parse: messagesParseStub } }),
  buildRephraseModel: () => null,
}));

import { StepVerificationError } from "@/scraper/errors";
import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";

const TOTAL_STEPS = 3;
const FAILING_STEP_INSTRUCTION = "Fill in field 0";

function flowArgv(stepCount: number): string[] {
  return [
    "node",
    "recon-browser.ts",
    "--url",
    "https://example.com/apply",
    "--flow",
    JSON.stringify(Array.from({ length: stepCount }, (_, i) => `Fill in field ${i}`)),
  ];
}

/** A page whose URL never moves — keeps the already-advanced short-circuit from swallowing the failure before it reaches the replan budget check. */
function makeFakePage(): { page: Page; stagehand: Stagehand } {
  const session = {
    on: (): void => {},
    off: (): void => {},
  };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: (): string => "https://example.com/apply",
    title: vi.fn().mockResolvedValue("Apply"),
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      if (typeof expr === "string" && expr.includes("document.body")) return 10_000;
      if (typeof expr === "string" && expr.includes("querySelector"))
        return { matched: false, src: null };
      return null;
    }),
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

describe("recon-browser/main — replan budget persists across a CDP-transport-retry fresh session (bugfix-001)", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-replan-budget-persists-"));
    process.env.RECON_RUN_ID = "20260917-000000-replanbudget";
    process.env.RECON_OUT_DIR = runsRoot;
    executeStepWithHealingStub.mockReset();
    guardedObserveStub.mockReset();
    guardedObserveStub.mockResolvedValue([]);
    messagesParseStub.mockReset();
    generateObjectStub.mockReset();
    vi.mocked(createBrowserSession).mockReset();
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

  it("carries cascadeReplansUsed from the first session into the retried session instead of resetting it to 0", async () => {
    const { stagehand: session1Stagehand } = makeFakePage();
    const { stagehand: session2Stagehand } = makeFakePage();
    const cdpTransportClosedError = {
      message: "scraper session's CDP transport was closed by the SDK: teardown initiated",
    };

    // First session: one whole-flow attempt that consumes the entire
    // cascade-replan budget (maxCascadeReplans=1) on step 0, then — after
    // completing the rest of the flow successfully — Stagehand's own CDP
    // transport is discovered torn down post-loop, triggering a retry on a
    // fresh session (mirrors cdp-transport-closed-mid-flow.test.ts).
    vi.mocked(createBrowserSession)
      .mockResolvedValueOnce({
        stagehand: session1Stagehand,
        limiter: {} as never,
        sessionId: "test-session-1",
        provider: "browserbase",
        close: vi.fn().mockResolvedValue(undefined),
        getCdpTransportClosedError: () => cdpTransportClosedError,
      } as never)
      // Second session: transport stays healthy so any failure surfaces as a
      // StepVerificationError instead of another CDP-triggered retry.
      .mockResolvedValueOnce({
        stagehand: session2Stagehand,
        limiter: {} as never,
        sessionId: "test-session-2",
        provider: "browserbase",
        close: vi.fn().mockResolvedValue(undefined),
        getCdpTransportClosedError: () => undefined,
      } as never);

    // The replan LLM call always proposes the same single bridge step —
    // called once on session 1 (consumes the only unit of budget) and must
    // NEVER be called again on session 2 if the budget correctly carried
    // over (usedSoFar=1 >= budget=1 aborts before reaching the LLM call).
    messagesParseStub.mockResolvedValue({
      parsed_output: { outcome: "replan", steps: ["Bridge step"] },
      content: [{ type: "text", text: "" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    executeStepWithHealingStub.mockImplementation(async (args: { step: string }) => {
      if (args.step === FAILING_STEP_INSTRUCTION) {
        throw new StepVerificationError(
          `step failed verification: ${args.step}`,
          "cascade-exhausted"
        );
      }
      return "completed";
    });

    process.argv = flowArgv(TOTAL_STEPS);

    // Session 1 burns the entire cascade budget on its one replan, then the
    // rest of the flow completes normally, then the transport-teardown
    // check fires and retries. Session 2's plan is the SAME original flow
    // (main() parses `flow` once), so step 0 fails identically — this must
    // hit the exhausted-budget abort immediately rather than being granted
    // a fresh 0/1 budget and replanning successfully again.
    await expect(main()).rejects.toThrow(`step failed verification: ${FAILING_STEP_INSTRUCTION}`);

    expect(createBrowserSession).toHaveBeenCalledTimes(2);
    // Exactly one replan LLM call across the whole run — proves the second
    // session's budget check saw usedSoFar=1 (carried over) and aborted
    // before ever reaching replanRemainingFlow's LLM call again.
    expect(messagesParseStub).toHaveBeenCalledTimes(1);
    expect(loggerStub.error).toHaveBeenCalledWith(
      expect.stringContaining("cascade-exhausted replan budget exhausted (1/1)")
    );
  });
});
