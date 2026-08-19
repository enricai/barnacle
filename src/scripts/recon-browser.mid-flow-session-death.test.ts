/**
 * Regression coverage for the recon CLI's own `main()` step loop (as
 * opposed to `runHealingFlow`, covered separately by
 * flow-runner.mid-flow-session-death.test.ts): a Stagehand session that
 * dies partway through a flow driven directly by `main()`'s loop must make
 * the run fail loudly, not silently walk through the remaining steps as if
 * they all completed. bugfix-001 closed this with a per-step liveness
 * gate; this file proves it end to end through the same `main()` harness
 * used elsewhere in recon-browser.test.ts.
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
      maxCascadeReplans: 5,
      maxProbeReplans: 5,
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
  SessionTimeoutError: class SessionTimeoutError extends Error {},
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

import { SessionTimeoutError } from "@/scraper/errors";
import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";

const TOTAL_STEPS = 5;
const SESSION_DIES_AFTER_STEP = 2;

/**
 * Fake `Page` whose `url()` throws once `killSession()` has been called,
 * mirroring `flow-runner.mid-flow-session-death.test.ts`'s
 * closed/dead-session model.
 */
function makeFakePage(): { page: Page; stagehand: Stagehand; killSession: () => void } {
  const session = {
    on: (): void => {},
    off: (): void => {},
  };
  let dead = false;
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: (): string => {
      if (dead) throw new Error("Target page, context or browser has been closed");
      return "https://example.com/apply";
    },
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
  return {
    page,
    stagehand,
    killSession: () => {
      dead = true;
    },
  };
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

describe("recon-browser/main — mid-flow session death (bugfix-002)", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-mid-flow-death-"));
    process.env.RECON_RUN_ID = "20260819-000000-midflowdeath";
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

  it("rejects instead of resolving when the session dies partway through the flow", async () => {
    const { stagehand, killSession } = makeFakePage();
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    let stepCount = 0;
    executeStepWithHealingStub.mockImplementation(async () => {
      stepCount += 1;
      if (stepCount === SESSION_DIES_AFTER_STEP) killSession();
      return "ok";
    });

    process.argv = flowArgv(TOTAL_STEPS);

    await expect(main()).rejects.toThrow(SessionTimeoutError);
    // The loop must stop once the dead session is detected, well short of
    // driving every declared step through to a false "completed" state.
    expect(stepCount).toBeLessThan(TOTAL_STEPS);
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(SESSION_DIES_AFTER_STEP);
  });

  it("rejects instead of resolving when the session is already dead at flow start", async () => {
    const { stagehand, killSession } = makeFakePage();
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    executeStepWithHealingStub.mockResolvedValue("ok");
    killSession();

    process.argv = flowArgv(TOTAL_STEPS);

    // The dead-page.url() read this exercises is the pre-loop bookkeeping
    // read at recon-browser.ts:2320 (`lastSuccessUrl = page.url()`), which
    // runs before the per-step liveness gate is ever reached — so this
    // surfaces the raw underlying Error rather than SessionTimeoutError.
    // Either way, main() must reject rather than run the loop through to
    // a false "completed" state.
    await expect(main()).rejects.toThrow(/closed/);
    expect(executeStepWithHealingStub).not.toHaveBeenCalled();
  });

  it("rejects when the session dies during the final step, after executeStepWithHealing resolves (bugfix-003)", async () => {
    const { stagehand, killSession } = makeFakePage();
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    let stepCount = 0;
    executeStepWithHealingStub.mockImplementation(async () => {
      stepCount += 1;
      // Session dies on the LAST step, after the healing call has already
      // resolved. With no further iteration to reach the next pre-step
      // liveness gate, only the post-step gate added right after this call
      // can catch it — without it the loop would exit and main() would
      // resolve as if the run completed cleanly.
      if (stepCount === TOTAL_STEPS) killSession();
      return "ok";
    });

    process.argv = flowArgv(TOTAL_STEPS);

    await expect(main()).rejects.toThrow(SessionTimeoutError);
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(TOTAL_STEPS);
  });

  it("resolves normally when the session stays alive for all steps (control case)", async () => {
    const { stagehand } = makeFakePage();
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    executeStepWithHealingStub.mockResolvedValue("ok");

    process.argv = flowArgv(TOTAL_STEPS);

    await expect(main()).resolves.toBeUndefined();
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(TOTAL_STEPS);
  });
});
