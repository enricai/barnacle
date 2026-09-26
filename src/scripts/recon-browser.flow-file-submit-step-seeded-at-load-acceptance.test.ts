/**
 * End-to-end acceptance regression for load-time `submitStep` seeding driven
 * through the real `--flow-file` path (as opposed to `--flow`, covered by
 * `recon-browser.replan-resume-target-submitstep-not-spuriously-seeded-regression.test.ts`,
 * or a fixture-repair scope). A step already persisted to disk by a prior
 * self-heal write-back — `origin: "replan"`, submit-shaped instruction text,
 * no `submitStep` key at all — must have `submitStep` seeded true by
 * `seedSubmitStepFromOwnInstructionText()` inside `parseCli()`, before the
 * step ever reaches `executeStepWithHealing`. Drives `main()` for real
 * against a temp JSON file so the read-file → normalizeFlow → seed pipeline
 * runs exactly as it does in production, independent of any replan-splice
 * code path.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { createBrowserSessionStub } = vi.hoisted(() => ({
  createBrowserSessionStub: vi.fn(),
}));
vi.mock("@/scraper/session", () => ({ createBrowserSession: createBrowserSessionStub }));
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

import { main } from "@/scripts/recon-browser";

const BASE_URL = "https://portal.example.net/app/checkout";
// Submit-shaped text (matches SUBMIT_SHAPED_INSTRUCTION_PATTERNS) so the
// load-time seedSubmitStepFromOwnInstructionText() call must flip it true.
const PERSISTED_STEP = "Click 'Place Order' to submit";

function makeFakePage(): { page: Page; stagehand: Stagehand } {
  const session = { on: (): void => {}, off: (): void => {} };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: (): string => BASE_URL,
    title: vi.fn().mockResolvedValue("Checkout"),
    evaluate: vi.fn().mockResolvedValue(10_000),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
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

describe("recon-browser/main — --flow-file step gets submitStep seeded from its own text at load", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;
  let flowDir: string;
  let flowFilePath: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-flowfile-seed-runs-"));
    flowDir = mkdtempSync(join(tmpdir(), "recon-browser-flowfile-seed-flow-"));
    flowFilePath = join(flowDir, "recon-flow.json");
    process.env.RECON_RUN_ID = "20260925-000000-flowfileseed";
    process.env.RECON_OUT_DIR = runsRoot;
    executeStepWithHealingStub.mockReset();
    guardedObserveStub.mockReset();
    guardedObserveStub.mockResolvedValue([]);
    createBrowserSessionStub.mockReset();
    loggerStub.info.mockClear();
    loggerStub.warn.mockClear();
    loggerStub.error.mockClear();
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    rmSync(flowDir, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
    executeStepWithHealingStub.mockReset();
    guardedObserveStub.mockReset();
  });

  it("seeds submitStep:true for a persisted replan-origin step with no submitStep key before the execution loop starts", async () => {
    // Mirrors the on-disk shape a prior self-heal write-back leaves behind:
    // origin: "replan", optional: true, no submitStep key at all.
    writeFileSync(
      flowFilePath,
      `${JSON.stringify([{ step: PERSISTED_STEP, optional: true, origin: "replan" }], null, 2)}\n`
    );

    const { stagehand } = makeFakePage();
    createBrowserSessionStub.mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    executeStepWithHealingStub.mockResolvedValue("completed");

    process.argv = ["node", "recon-browser.ts", "--url", BASE_URL, "--flow-file", flowFilePath];

    await expect(main()).resolves.toBeUndefined();

    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(1);
    const [callArgs] = executeStepWithHealingStub.mock.calls[0] as [
      { step: string; submitStep: boolean },
    ];
    expect(callArgs.step).toBe(PERSISTED_STEP);
    // Proves classification happened at load time in parseCli(), before the
    // execution loop ever ran — not via any replan-splice code path.
    expect(callArgs.submitStep).toBe(true);
  });
});
