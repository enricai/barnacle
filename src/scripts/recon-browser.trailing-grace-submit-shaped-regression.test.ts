/**
 * Regression pinning that the Tier-1 trailing-grace judge-verification path
 * (verifySubmitWithLLM, recon-browser.ts:3076-3115) remains independently
 * reachable after the hasPageAlreadyAdvancedPastStep short-circuit was gated
 * off for submitStep-flagged steps. That gate only touches the deterministic
 * origin/path-only shortcut earlier in the same catch block — it must not
 * collaterally disable the separate trailing-grace exit that legitimately
 * credits a genuine trailing optional submission already confirmed server-side.
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

describe("recon-browser/main — trailing-grace submit-shaped regression", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-trailing-grace-submit-shaped-"));
    process.env.RECON_RUN_ID = "20260927-000000-trailinggracesubmitshaped";
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

  it("still exits via the trailing-grace path when a genuine trailing submit is judge-verified, unaffected by the submit-step short-circuit gate", async () => {
    // Single trailing optional step (e.g. "place order" flow's final,
    // redundant "Continue" tap). Its own cascade fails verification, but a
    // genuine submit already landed server-side and the judge confirms it
    // from recent capture history — the trailing-grace exit, not the
    // gated origin/path-only shortcut, is what must credit this run.
    const session = {
      on: (): void => {},
      off: (): void => {},
    };
    // The page URL genuinely advances between step-start and post-failure —
    // origin+path differ, so hasPageAlreadyAdvancedPastStep would read true —
    // to prove the submitStep gate (not merely a same-URL no-op) is what
    // keeps the trailing-grace path reachable for a submit-shaped step.
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
      JSON.stringify({
        steps: [
          {
            step: "Place the order",
            optional: true,
            upload: false,
          },
        ],
      }),
    ];

    await expect(main()).resolves.not.toThrow();

    expect(verifySubmitWithLLMStub).toHaveBeenCalled();
    expect(loggerStub.info).toHaveBeenCalledWith(
      expect.stringContaining(TRAILING_GRACE_LOG_FRAGMENT)
    );
  });
});
