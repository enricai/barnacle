/**
 * Integration test for main()'s cause-aware replan no-progress guard: a replan
 * that re-proposes only the just-failed step is retried (bounded) when the
 * recorded cascade attempts failed solely on transient provider errors, and
 * aborts immediately when they carry a real selector failure. Drives the real
 * main(); only the session, step executor and replan LLM are stubbed.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
      maxCascadeReplans: 6,
      maxProbeReplans: 2,
      maxTransportRetries: 2,
    },
    telemetry: {
      callsNdjsonPath: ".barnacle/calls.ndjson",
    },
  },
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));

// `waitForSpaReady` gates readiness with `withWatchdog`, which races the
// fake page's mocked `evaluate()` against a REAL `setTimeout`. The mocked
// promise settles synchronously in test terms, but under scheduler
// contention its microtask can be starved past the watchdog's real timer,
// spuriously "timing out" and driving the function into its real
// `page.waitForTimeout`-polling loop against a real `Date.now()` deadline —
// a genuine wall-clock dependency this test must not inherit, since it is
// orthogonal to the cascade-budget/replan-cycle abort signature under test.
vi.mock("@/scraper/spa-readiness", () => ({
  waitForSpaReady: vi.fn().mockResolvedValue(undefined),
}));

const { createBrowserSessionStub } = vi.hoisted(() => ({
  createBrowserSessionStub: vi.fn(),
}));
vi.mock("@/scraper/session", () => ({ createBrowserSession: createBrowserSessionStub }));

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

const { messagesParseStub } = vi.hoisted(() => ({ messagesParseStub: vi.fn() }));
vi.mock("@/lib/llm/anthropic-client", () => ({
  buildAnthropicClient: () => ({ messages: { parse: messagesParseStub } }),
  buildRephraseModel: () => null,
}));

import type { Page, Stagehand } from "@browserbasehq/stagehand";

const BASE_URL = "https://portal.example.com/app/apply";
const STEP = "Click the 'Submit Application' button";

function makeStagehand(): Stagehand {
  const session = { on: (): void => {}, off: (): void => {} };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: (): string => BASE_URL,
    title: vi.fn().mockResolvedValue("Apply"),
    evaluate: vi.fn().mockResolvedValue(10_000),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    frames: vi.fn().mockReturnValue([]),
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ cookies: [] }),
  } as unknown as Page;
  return { context: { awaitActivePage: async (): Promise<Page> => page } } as unknown as Stagehand;
}

async function runWithAttemptError(attemptError: string): Promise<{
  error: { kind: string; message: string };
  execCalls: number;
  warns: string[];
}> {
  const root = mkdtempSync(join(tmpdir(), "recon-browser-transient-replan-"));
  process.env.RECON_RUN_ID = "20261014-000000-transientreplan";
  process.env.RECON_OUT_DIR = root;
  process.argv = ["node", "vitest"];
  vi.resetModules();
  try {
    const { StepVerificationError } = await import("@/scraper/errors.js");
    const { main } = await import("@/scripts/recon-browser.js");
    const dumpPath = join(root, "failure-dump.json");
    writeFileSync(
      dumpPath,
      JSON.stringify({ attempts: [{ errorMessage: attemptError }, { errorMessage: attemptError }] })
    );

    createBrowserSessionStub.mockReset();
    createBrowserSessionStub.mockResolvedValueOnce({
      stagehand: makeStagehand(),
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
      getCdpTransportClosedError: () => undefined,
    } as never);

    messagesParseStub.mockReset();
    messagesParseStub.mockResolvedValue({
      parsed_output: { outcome: "replan", steps: [STEP] },
      content: [{ type: "text", text: "" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    executeStepWithHealingStub.mockReset();
    executeStepWithHealingStub.mockImplementation(async () => {
      throw new StepVerificationError(`step failed, see ${dumpPath}`, "cascade-exhausted");
    });
    guardedObserveStub.mockReset();
    guardedObserveStub.mockResolvedValue([]);
    generateObjectStub.mockReset();
    loggerStub.warn.mockClear();
    loggerStub.error.mockClear();

    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      BASE_URL,
      "--flow",
      JSON.stringify([STEP]),
    ];
    let thrown: unknown;
    try {
      await main();
    } catch (err) {
      thrown = err;
    }
    if (!(thrown instanceof StepVerificationError)) {
      throw new Error(`expected StepVerificationError, got: ${String(thrown)}`);
    }
    return {
      error: thrown,
      execCalls: executeStepWithHealingStub.mock.calls.length,
      warns: loggerStub.warn.mock.calls.map((c) => String(c[0])),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("recon-browser/main transient-aware replan no-progress guard", () => {
  afterEach(() => {
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
  });

  it("retries twice on provider-only failures, then aborts without tripping the cycle detector", async () => {
    const r = await runWithAttemptError("An internal server error occurred");
    expect(r.error.kind).toBe("replan-cycle-detected");
    expect(r.error.message).toContain("resuming would re-fail identically");
    expect(r.error.message).not.toContain("replan cycle detected");
    expect(r.execCalls).toBe(3);
    expect(r.warns.filter((w) => w.includes("allowing bounded re-run"))).toHaveLength(2);
  });

  it("aborts on the first occurrence for a selector failure", async () => {
    const r = await runWithAttemptError("selector not found");
    expect(r.error.kind).toBe("replan-cycle-detected");
    expect(r.error.message).toContain("resuming would re-fail identically");
    expect(r.execCalls).toBe(1);
    expect(r.warns.filter((w) => w.includes("allowing bounded re-run"))).toHaveLength(0);
  });
});
