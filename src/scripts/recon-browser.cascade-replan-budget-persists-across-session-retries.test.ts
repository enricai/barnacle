/**
 * Regression coverage for bugfix-001: `probeReplansUsed`/`cascadeReplansUsed`
 * must be declared in main()'s outer scope (above `runFlowAttempt`) so a
 * genuine CDP-transport teardown mid-flow — which makes `withScraperRetry`
 * re-invoke `runFlowAttempt` on a fresh session — accumulates against the
 * SAME budget ceiling instead of silently resetting to 0 per attempt.
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

// Sidesteps guardedObserve/probeLeafInvalidContainers's real DOM-probing
// machinery — this suite only cares about the replan-budget counters, not
// the candidate-list/leaf-field rendering replanRemainingFlow feeds the LLM.
vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return { ...actual, guardedObserve: vi.fn().mockResolvedValue([]) };
});

const { executeStepWithHealingStub } = vi.hoisted(() => ({
  executeStepWithHealingStub: vi.fn(),
}));
vi.mock("@/scraper/flow-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/flow-runner")>();
  return {
    ...actual,
    executeStepWithHealing: executeStepWithHealingStub,
    probeLeafInvalidContainers: vi.fn().mockResolvedValue([]),
  };
});

// replanRemainingFlow (real, un-mocked — internal to recon-browser.ts) calls
// the Anthropic SDK's structured-output `messages.parse` directly. Stub the
// SDK class so each replan call resolves with a fresh, distinct bridge step —
// distinct text keeps isReplanCycle/isReplanReproposingFailedStep from firing
// and short-circuiting the budget math this suite is trying to exercise.
let replanCallCount = 0;
const messagesParseStub = vi.fn().mockImplementation(() => {
  replanCallCount += 1;
  return Promise.resolve({
    parsed_output: { outcome: "replan", steps: [`Bridge step ${replanCallCount}`] },
    content: [{ type: "text", text: "" }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
});
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { parse: messagesParseStub };
  },
}));

const { generateObjectStub } = vi.hoisted(() => ({ generateObjectStub: vi.fn() }));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateObject: generateObjectStub,
  };
});

import { CdpTransportClosedError, StepVerificationError } from "@/scraper/errors";
import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";

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

describe("recon-browser/main — cascade replan budget persists across a CDP-transport-teardown session retry (bugfix-001)", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-replan-budget-"));
    process.env.RECON_RUN_ID = "20260917-000000-replanbudget";
    process.env.RECON_OUT_DIR = runsRoot;
    executeStepWithHealingStub.mockReset();
    vi.mocked(createBrowserSession).mockReset();
    replanCallCount = 0;
    messagesParseStub.mockClear();
    generateObjectStub.mockResolvedValue({
      object: { fields: [], messages: [] },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
    executeStepWithHealingStub.mockReset();
  });

  it("carries cascadeReplansUsed across a fresh-session retry instead of resetting to 0/5", async () => {
    const { stagehand: session1 } = makeFakePage();
    const { stagehand: session2 } = makeFakePage();
    vi.mocked(createBrowserSession)
      .mockResolvedValueOnce({
        stagehand: session1,
        limiter: {} as never,
        sessionId: "test-session-1",
        provider: "browserbase",
        close: vi.fn().mockResolvedValue(undefined),
        getCdpTransportClosedError: () => undefined,
      } as never)
      .mockResolvedValueOnce({
        stagehand: session2,
        limiter: {} as never,
        sessionId: "test-session-2",
        provider: "browserbase",
        close: vi.fn().mockResolvedValue(undefined),
        getCdpTransportClosedError: () => undefined,
      } as never);

    // Attempt 1: every step invocation fails cascade-exhausted, burning 3 of
    // the 5-cascade budget across 3 replans, then the 4th step invocation
    // simulates Stagehand's own mid-flow CDP teardown (a distinct error type,
    // never counted against the replan budget) — triggering withScraperRetry's
    // fresh-session retry. Attempt 2 (fresh session) must abort after only 2
    // MORE replans (5/5 total), not reset to a fresh 0/5 and take 5 more.
    let callIndex = 0;
    executeStepWithHealingStub.mockImplementation(() => {
      callIndex += 1;
      if (callIndex === 4) return Promise.reject(new CdpTransportClosedError());
      return Promise.reject(new StepVerificationError("no observable effect", "cascade-exhausted"));
    });

    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://example.com/apply",
      "--flow",
      JSON.stringify(["Fill field"]),
    ];

    await expect(main()).rejects.toThrow("no observable effect");

    // A fresh session per whole-flow attempt.
    expect(createBrowserSession).toHaveBeenCalledTimes(2);

    const allErrorLogs = loggerStub.error.mock.calls
      .map((args: unknown[]) => args.map(String).join(" "))
      .join("\n");
    expect(allErrorLogs).toContain("cascade-exhausted replan budget exhausted (5/5)");

    // The decisive assertion: only 5 total "attempting global replan" calls
    // across BOTH attempts (3 in attempt 1 + 2 in attempt 2). If the budget
    // had reset to 0/5 on the fresh session, attempt 2 alone would need 5
    // more replans before exhausting (8 total), not 2.
    const allWarnLogs = loggerStub.warn.mock.calls
      .map((args: unknown[]) => args.map(String).join(" "))
      .join("\n");
    const replanAttempts = allWarnLogs.match(/attempting global replan #\d+/g) ?? [];
    expect(replanAttempts).toHaveLength(5);
  });
});
