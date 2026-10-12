/**
 * End-to-end coverage for the contract that an expired-lifetime session death
 * fails fast (one session, process.exit(1), no restart from step 1)
 * regardless of how main() observes it: a thrown deathSignal rejection, a raw
 * uninitialized-Stagehand error from a step, or a death before the lifetime
 * (regression guard: still retries on a fresh session).
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

import { CdpTransportClosedError } from "@/scraper/errors";
import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";

const TOTAL_STEPS = 10;
const DEATH_AFTER_STEP = 6;

/**
 * Fake `Page` that stays alive for the whole flow — this suite's teardown
 * signal is `getCdpTransportClosedError()`, not a dead `page.url()` read,
 * so the page itself must never throw.
 */
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

describe("recon-browser/main — mid-step death after the configured lifetime fails fast", () => {
  const ORIGINAL_ARGV = process.argv;
  const HIT = { configuredTimeoutSeconds: 900, elapsedSeconds: 899.5 };
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-session-timeout-fail-fast-"));
    process.env.RECON_RUN_ID = "20260819-000000-timeoutfailfast";
    process.env.RECON_OUT_DIR = runsRoot;
    executeStepWithHealingStub.mockReset();
    vi.mocked(createBrowserSession).mockReset();
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
    executeStepWithHealingStub.mockReset();
  });

  async function expectFailFast(session: Record<string, unknown>): Promise<void> {
    const { stagehand } = makeFakePage();
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
      ...session,
    } as never);
    process.argv = flowArgv(TOTAL_STEPS);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    await expect(main()).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(createBrowserSession).toHaveBeenCalledTimes(1);
    exitSpy.mockRestore();
  }

  it("deathSignal rejection mid-step after lifetime: one session, step 1 never re-executed", async () => {
    let signalDeath: ((err: Error) => void) | undefined;
    const deathSignal = new Promise<never>((_resolve, reject) => {
      signalDeath = reject;
    });
    deathSignal.catch(() => undefined);
    let calls = 0;
    executeStepWithHealingStub.mockImplementation(() => {
      calls += 1;
      if (calls === DEATH_AFTER_STEP) {
        setTimeout(() => signalDeath?.(new CdpTransportClosedError("closed")), 0);
        return new Promise(() => {});
      }
      return Promise.resolve("ok");
    });
    await expectFailFast({ deathSignal, getSessionTimeoutHit: () => HIT });
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(DEATH_AFTER_STEP);
    expect(loggerStub.error).toHaveBeenCalledWith(
      expect.stringContaining("BROWSERBASE_SESSION_TIMEOUT_SECONDS")
    );
  });

  it("raw uninitialized-Stagehand error mid-step after lifetime: one session, step 1 never re-executed", async () => {
    let calls = 0;
    executeStepWithHealingStub.mockImplementation(async () => {
      calls += 1;
      if (calls === DEATH_AFTER_STEP) {
        throw new Error("StagehandNotInitializedError: Stagehand is not initialized");
      }
      return "ok";
    });
    await expectFailFast({ getSessionTimeoutHit: () => HIT });
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(DEATH_AFTER_STEP);
    expect(loggerStub.error).toHaveBeenCalledWith(
      expect.stringContaining("BROWSERBASE_SESSION_TIMEOUT_SECONDS")
    );
  });

  it("regression guard: death before the lifetime still retries on a fresh session", async () => {
    const { stagehand: dyingStagehand } = makeFakePage();
    const { stagehand: healthyStagehand } = makeFakePage();
    vi.mocked(createBrowserSession)
      .mockResolvedValueOnce({
        stagehand: dyingStagehand,
        limiter: {} as never,
        sessionId: "test-session-1",
        provider: "browserbase",
        close: vi.fn().mockResolvedValue(undefined),
        getSessionTimeoutHit: () => undefined,
        deathSignal: Promise.reject(new CdpTransportClosedError("closed early")),
      } as never)
      .mockResolvedValueOnce({
        stagehand: healthyStagehand,
        limiter: {} as never,
        sessionId: "test-session-2",
        provider: "browserbase",
        close: vi.fn().mockResolvedValue(undefined),
      } as never);
    let calls = 0;
    executeStepWithHealingStub.mockImplementation(() => {
      calls += 1;
      return calls === DEATH_AFTER_STEP ? new Promise(() => {}) : Promise.resolve("ok");
    });
    process.argv = flowArgv(TOTAL_STEPS);
    await expect(main()).resolves.toBeUndefined();
    expect(createBrowserSession).toHaveBeenCalledTimes(2);
  });
});
