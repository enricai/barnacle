/**
 * Pins that the trailing-grace verifySubmitWithLLM call in recon-browser
 * receives the same finality as the shared isGenuineFinalSubmit predicate:
 * a last slot without submit semantics (e.g. a replan trimmed the tail) is
 * mid-flow (isFinalStep=false); a genuine final slot with submit semantics
 * is final (isFinalStep=true).
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

const { verifySubmitWithLLMStub } = vi.hoisted(() => ({
  verifySubmitWithLLMStub: vi.fn(),
}));
vi.mock("@/lib/llm/judges/verify-submit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/judges/verify-submit")>();
  return {
    ...actual,
    verifySubmitWithLLM: verifySubmitWithLLMStub,
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

import { StepVerificationError } from "@/scraper/errors";
import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";

const TRAILING_GRACE_LOG_FRAGMENT = "judge verified recent submit";

describe("recon-browser/main — trailing-grace mid-flow-aware finality", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-trailing-grace-midflow-"));
    process.env.RECON_RUN_ID = "20260927-000000-trailinggracemidflow";
    process.env.RECON_OUT_DIR = runsRoot;
    executeStepWithHealingStub.mockReset();
    verifySubmitWithLLMStub.mockReset();
    loggerStub.info.mockReset();
    vi.mocked(createBrowserSession).mockReset();
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
    executeStepWithHealingStub.mockReset();
    verifySubmitWithLLMStub.mockReset();
  });

  async function runWithFlow(steps: Array<Record<string, unknown>>): Promise<void> {
    const session = { on: (): void => {}, off: (): void => {} };
    const pageUrl = vi
      .fn()
      .mockReturnValueOnce("https://orders.example.com/checkout/review")
      .mockReturnValue("https://orders.example.com/checkout/confirm");
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: pageUrl,
      title: vi.fn().mockResolvedValue("Order Confirmation"),
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

    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    executeStepWithHealingStub.mockImplementation(async () => {
      throw new StepVerificationError("no observable effect", "cascade-exhausted");
    });
    verifySubmitWithLLMStub.mockResolvedValue({
      verified: true,
      rationale: "recent 2xx POST to the site's own backend landed on the order confirmation page",
    });

    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://orders.example.com/checkout/review",
      "--flow",
      JSON.stringify({ steps }),
    ];

    await expect(main()).resolves.not.toThrow();
  }

  it("passes isFinalStep=false for a last optional slot when the flow has no submit semantics", async () => {
    await runWithFlow([{ step: "Click the Continue button", optional: true, upload: false }]);

    expect(verifySubmitWithLLMStub).toHaveBeenCalled();
    const judgeInput = verifySubmitWithLLMStub.mock.calls[0]?.[0]?.input;
    expect(judgeInput.stepInstruction).toBe("Click the Continue button");
    expect(judgeInput.isFinalStep).toBe(false);
    expect(loggerStub.info).toHaveBeenCalledWith(
      expect.stringContaining(TRAILING_GRACE_LOG_FRAGMENT)
    );
  });

  it("passes isFinalStep=true for the last optional slot when the flow has submit semantics", async () => {
    await runWithFlow([
      { step: "Click the Continue button", optional: true, upload: false, submitStep: true },
    ]);

    expect(verifySubmitWithLLMStub).toHaveBeenCalled();
    const judgeInput = verifySubmitWithLLMStub.mock.calls[0]?.[0]?.input;
    expect(judgeInput.stepInstruction).toBe("Click the Continue button");
    expect(judgeInput.isFinalStep).toBe(true);
    expect(loggerStub.info).toHaveBeenCalledWith(
      expect.stringContaining(TRAILING_GRACE_LOG_FRAGMENT)
    );
  });
});
