/**
 * End-to-end coverage for main()'s CDP-transport-teardown handling: a
 * Stagehand-initiated transport teardown mid-flow must make the whole-flow
 * attempt fail (isFlowTruncated alone never fires for this case, since the
 * per-step loop mechanics still report every step "completed"). bugfix-003
 * changed the immediate `process.exit(1)` into a bounded fresh-session retry
 * (up to `config.scraper.maxTransportRetries` attempts, via
 * `withScraperRetry`) — main() only calls `process.exit(1)` once every
 * attempt has hit the same failure. Mirrors the harness in
 * recon-browser.mid-flow-session-death.test.ts.
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

import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";

const TOTAL_STEPS = 10;
const TRANSPORT_CLOSES_AFTER_STEP = 6;

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

describe("recon-browser/main — CDP transport closed mid-flow by Stagehand's own teardown", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-cdp-transport-closed-"));
    process.env.RECON_RUN_ID = "20260819-000000-cdptransport";
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

  it("retries on a fresh session up to maxTransportRetries, then rejects once every attempt hits the same CDP teardown", async () => {
    const { stagehand } = makeFakePage();
    const cdpTransportClosedError = {
      message: "scraper session's CDP transport was closed by the SDK: teardown initiated",
    };
    // Every fresh session torn down by Stagehand at the same point — this
    // never recovers, so all maxTransportRetries (3) attempts fail.
    let transportClosed = false;
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
      // Analogous to `killSession()` in the dead-page harness, but this
      // models the session's real teardown-detection accessor: the SDK's
      // own transport-close hook (session-browserbase.ts/session-steel.ts's
      // `conn.onTransportClosed`), not a thrown error or a dead page read.
      getCdpTransportClosedError: () => (transportClosed ? cdpTransportClosedError : undefined),
    } as never);

    let stepCountInAttempt = 0;
    executeStepWithHealingStub.mockImplementation(async () => {
      stepCountInAttempt += 1;
      // Stagehand's teardown does not surface as a thrown error or a dead
      // page.url() read — every remaining step still reports "completed"
      // via the loop's normal mechanics, exactly like isFlowTruncated's
      // completedSteps.length would look satisfied.
      if (stepCountInAttempt === TRANSPORT_CLOSES_AFTER_STEP) transportClosed = true;
      if (stepCountInAttempt === TOTAL_STEPS) stepCountInAttempt = 0;
      return "ok";
    });

    process.argv = flowArgv(TOTAL_STEPS);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await expect(main()).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    // 3 whole-flow attempts, a brand-new session each time, each running
    // every declared step to completion before the post-loop guard fires.
    expect(createBrowserSession).toHaveBeenCalledTimes(3);
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(TOTAL_STEPS * 3);
    expect(loggerStub.error).toHaveBeenCalledWith(expect.stringContaining("CDP transport"));

    exitSpy.mockRestore();
  });

  it("recovers on a retried attempt when the fresh session's transport stays open", async () => {
    const { stagehand: closingStagehand } = makeFakePage();
    const { stagehand: healthyStagehand } = makeFakePage();
    const cdpTransportClosedError = {
      message: "scraper session's CDP transport was closed by the SDK: teardown initiated",
    };

    vi.mocked(createBrowserSession)
      .mockResolvedValueOnce({
        stagehand: closingStagehand,
        limiter: {} as never,
        sessionId: "test-session-1",
        provider: "browserbase",
        close: vi.fn().mockResolvedValue(undefined),
        getCdpTransportClosedError: () => cdpTransportClosedError,
      } as never)
      .mockResolvedValueOnce({
        stagehand: healthyStagehand,
        limiter: {} as never,
        sessionId: "test-session-2",
        provider: "browserbase",
        close: vi.fn().mockResolvedValue(undefined),
        getCdpTransportClosedError: () => undefined,
      } as never);

    executeStepWithHealingStub.mockResolvedValue("ok");

    process.argv = flowArgv(TOTAL_STEPS);

    await expect(main()).resolves.toBeUndefined();
    expect(createBrowserSession).toHaveBeenCalledTimes(2);
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(TOTAL_STEPS * 2);
  });

  it("resolves normally end to end when Stagehand never tears the transport down (control case)", async () => {
    const { stagehand } = makeFakePage();
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
      getCdpTransportClosedError: () => undefined,
    } as never);

    executeStepWithHealingStub.mockResolvedValue("ok");

    process.argv = flowArgv(TOTAL_STEPS);

    await expect(main()).resolves.toBeUndefined();
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(TOTAL_STEPS);
  });
});
