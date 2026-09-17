/**
 * Regression pin for bugfix-001: `cascadeReplansUsed` lived inside
 * `runFlowAttempt()`'s closure, so a CdpTransportClosedError-triggered retry
 * on a fresh session (`withScraperRetry` re-invoking `runFlowAttempt()`)
 * reset the counter to 0 — silently doubling the effective cascade-replan
 * budget across sessions instead of sharing one bounded budget for the
 * whole run. Unlike recon-browser.replan-budget-persists-across-cdp-transport-retry-acceptance.test.ts
 * (a 1-unit budget consumed in a single replan), this pins the general case:
 * a multi-replan chain that partially consumes a 5-unit budget (3 replans)
 * before the transport teardown, then must exhaust only the remaining 2 on
 * the retried session instead of being granted a fresh 5/5.
 * Mirrors the main()-driving harness in
 * recon-browser.cdp-transport-closed-mid-flow.test.ts and
 * recon-browser.session-churn-on-effective-verdict-acceptance.test.ts.
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

const ORIGINAL_STEP = "Fill in field 0";
const FAILING_STEPS = new Set([ORIGINAL_STEP, "Bridge 1", "Bridge 2", "Bridge 4", "Bridge 5"]);

function flowArgv(): string[] {
  return [
    "node",
    "recon-browser.ts",
    "--url",
    "https://example.com/apply",
    "--flow",
    JSON.stringify([ORIGINAL_STEP]),
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

describe("recon-browser/main — cascade replan budget persists across a CDP-transport-retry session (bugfix-001)", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-cascade-budget-persists-"));
    process.env.RECON_RUN_ID = "20260917-000000-cascadebudget";
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

  it("carries 3 of 5 cascadeReplansUsed from the first session into the retried session, exhausting only the remaining 2", async () => {
    const { stagehand: session1Stagehand } = makeFakePage();
    const { stagehand: session2Stagehand } = makeFakePage();
    const cdpTransportClosedError = {
      message: "scraper session's CDP transport was closed by the SDK: teardown initiated",
    };

    // First session: three chained cascade replans (step0 -> Bridge1 -> Bridge2
    // -> Bridge3), the last of which succeeds and completes the flow. Only
    // afterwards does the post-loop check discover the session's CDP
    // transport was torn down, forcing a retry on a fresh session (mirrors
    // cdp-transport-closed-mid-flow.test.ts).
    vi.mocked(createBrowserSession)
      .mockResolvedValueOnce({
        stagehand: session1Stagehand,
        limiter: {} as never,
        sessionId: "test-session-1",
        provider: "browserbase",
        close: vi.fn().mockResolvedValue(undefined),
        getCdpTransportClosedError: () => cdpTransportClosedError,
      } as never)
      // Second session: transport stays healthy so the final exhaustion
      // surfaces as a StepVerificationError instead of another CDP retry.
      .mockResolvedValueOnce({
        stagehand: session2Stagehand,
        limiter: {} as never,
        sessionId: "test-session-2",
        provider: "browserbase",
        close: vi.fn().mockResolvedValue(undefined),
        getCdpTransportClosedError: () => undefined,
      } as never);

    // 5 sequential replan proposals: 3 consumed on session 1 (step0, Bridge1,
    // Bridge2 all fail and bridge onward), 2 more consumed on session 2
    // (step0 fails again identically, then Bridge4 fails) before the 5/5
    // budget check aborts on Bridge5's failure without ever proposing a 6th.
    messagesParseStub
      .mockResolvedValueOnce(replanResponse("Bridge 1"))
      .mockResolvedValueOnce(replanResponse("Bridge 2"))
      .mockResolvedValueOnce(replanResponse("Bridge 3"))
      .mockResolvedValueOnce(replanResponse("Bridge 4"))
      .mockResolvedValueOnce(replanResponse("Bridge 5"));

    executeStepWithHealingStub.mockImplementation(async (args: { step: string }) => {
      if (FAILING_STEPS.has(args.step)) {
        throw new StepVerificationError(
          `step failed verification: ${args.step}`,
          "cascade-exhausted"
        );
      }
      return "completed";
    });

    process.argv = flowArgv();

    // Session 2 re-parses the SAME original flow (main() parses `flow` once
    // and reuses it per retry attempt), so step0 fails identically and the
    // cascade chain resumes at usedSoFar=3 — not a fresh 0/5 — exhausting on
    // Bridge5's failure at exactly 5/5 after only 2 more replans.
    await expect(main()).rejects.toThrow("step failed verification: Bridge 5");

    expect(createBrowserSession).toHaveBeenCalledTimes(2);
    // 5 replan LLM calls total across both sessions — 3 on session 1, 2 on
    // session 2 — proves the second session's budget check saw usedSoFar=3
    // carried over instead of resetting to 0.
    expect(messagesParseStub).toHaveBeenCalledTimes(5);
    expect(loggerStub.error).toHaveBeenCalledWith(
      expect.stringContaining("cascade-exhausted replan budget exhausted (5/5)")
    );
  });
});
