/**
 * Regression tests for the recon CLI's navigateTo step: parseCli/normalizeFlow
 * must carry `navigateTo` through the NormalizedStep round-trip, and main()'s
 * step loop must dispatch a navigateTo step straight to executeNavigateStep
 * instead of the act()/observe self-heal cascade.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
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
      frameReadyTimeoutMs: 20_000,
      frameDocumentReadyTimeoutMs: 5_000,
      frameEvaluateTimeoutMs: 30_000,
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

vi.mock("@/lib/llm/anthropic-client", () => ({
  buildAnthropicClient: () => null,
  buildRephraseModel: () => null,
}));

// executeStepWithHealing and executeNavigateStep are both spied so tests can
// assert exactly which one main()'s step loop dispatches to; every other
// flow-runner export stays real.
const { executeStepWithHealingStub, executeNavigateStepStub } = vi.hoisted(() => ({
  executeStepWithHealingStub: vi.fn(),
  executeNavigateStepStub: vi.fn(),
}));
vi.mock("@/scraper/flow-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/flow-runner")>();
  return {
    ...actual,
    executeStepWithHealing: executeStepWithHealingStub,
    executeNavigateStep: executeNavigateStepStub,
  };
});

import { createBrowserSession } from "@/scraper/session";
import { main, parseCli } from "@/scripts/recon-browser";

function makeFakePage(): { page: Page; stagehand: Stagehand } {
  const session = {
    on: (): void => {},
    off: (): void => {},
  };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: (): string => "https://example.com",
    title: vi.fn().mockResolvedValue("Example"),
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      if (typeof expr === "string" && expr.includes("document.body")) return 10_000;
      if (typeof expr === "string" && expr.includes("querySelector")) {
        return { matched: false, src: null };
      }
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

describe("recon-browser CLI/parseCli — navigateTo round-trip through NormalizedStep", () => {
  const ORIGINAL_ARGV = process.argv;

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
  });

  it("parses navigateTo off an object-shape flow step without throwing", () => {
    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://example.com",
      "--flow",
      JSON.stringify([
        {
          step: "go to the unfiltered view",
          navigateTo: "https://example.com/unfiltered",
          optional: true,
        },
      ]),
    ];

    expect(() => parseCli()).not.toThrow();
  });
});

describe("recon-browser CLI/main — navigateTo dispatches to executeNavigateStep", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-navigate-step-"));
    process.env.RECON_RUN_ID = "20260902-000000-navigatestep";
    process.env.RECON_OUT_DIR = runsRoot;
    executeStepWithHealingStub.mockReset();
    executeStepWithHealingStub.mockResolvedValue("completed");
    executeNavigateStepStub.mockReset();
    executeNavigateStepStub.mockResolvedValue("completed");
    vi.mocked(createBrowserSession).mockReset();
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
    executeStepWithHealingStub.mockReset();
    executeNavigateStepStub.mockReset();
  });

  it("calls executeNavigateStep with page.goto semantics and never the healing cascade for a navigateTo step", async () => {
    const { stagehand, page } = makeFakePage();
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://example.com",
      "--flow",
      JSON.stringify([
        {
          step: "go to the unfiltered view",
          navigateTo: "https://example.com/unfiltered",
          optional: true,
        },
      ]),
    ];

    await main();

    expect(executeNavigateStepStub).toHaveBeenCalledTimes(1);
    const callArgs = executeNavigateStepStub.mock.calls[0]?.[0] as {
      url?: string;
      optional?: boolean;
      page?: Page;
    };
    expect(callArgs.url).toBe("https://example.com/unfiltered");
    expect(callArgs.optional).toBe(true);
    expect(callArgs.page).toBe(page);
    expect(executeStepWithHealingStub).not.toHaveBeenCalled();
  });
});
