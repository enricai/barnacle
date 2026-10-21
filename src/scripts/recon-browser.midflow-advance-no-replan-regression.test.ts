/**
 * Regression guard: a non-final submit-shaped step whose page advanced from the
 * step-start state (late body re-render, zero network) is credited once and the
 * run resumes with the tail; earlier fill steps are never re-run by a replan.
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

const { generateObjectStub } = vi.hoisted(() => ({ generateObjectStub: vi.fn() }));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateObject: generateObjectStub,
  };
});

const { executeStepWithHealingStub, snapshotPageStub, settleStub } = vi.hoisted(() => ({
  executeStepWithHealingStub: vi.fn(),
  snapshotPageStub: vi.fn(),
  settleStub: vi.fn(),
}));

vi.mock("@/scraper/flow-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/flow-runner")>();
  return {
    ...actual,
    executeStepWithHealing: executeStepWithHealingStub,
    snapshotPage: snapshotPageStub,
    settleWithPageQuiescence: settleStub,
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

import { StepVerificationError } from "@/scraper/errors";
import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";

const CHROME = "Site header nav footer links ".repeat(10);
const PRE = {
  networkCount: 0,
  url: "https://apply.example.com/wizard",
  bodyHtmlLength: 1000,
  visibleTextSignature: `300:Personal info ${CHROME}`,
  visibleTextDigest: "a",
};
const FLIPPED = {
  ...PRE,
  visibleTextSignature: `300:Work history ${CHROME}`,
  visibleTextDigest: "b",
};
const ADVANCE_LOG = "verification failed but the page already advanced past this step";
const FILL_EMAIL = "Fill in the Email field";
const SUBMIT = "Click the Continue button to submit this page";
const TAIL = "Fill in the Employer field";

function argv(): string[] {
  return [
    "node",
    "recon-browser.ts",
    "--url",
    "https://apply.example.com/wizard",
    "--flow",
    JSON.stringify({ steps: [FILL_EMAIL, { step: SUBMIT, submitStep: true }, TAIL] }),
  ];
}

function executedInstructions(): string[] {
  return executeStepWithHealingStub.mock.calls.map((c) => (c[0] as { step: string }).step);
}

describe("recon-browser/main — mid-flow settled advance does not replan", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-midflow-noreplan-"));
    process.env.RECON_RUN_ID = "20261021-000000-midflownoreplan";
    process.env.RECON_OUT_DIR = runsRoot;
    for (const stub of [
      executeStepWithHealingStub,
      guardedObserveStub,
      generateObjectStub,
      snapshotPageStub,
      settleStub,
      loggerStub.info,
    ])
      stub.mockReset();
    settleStub.mockResolvedValue(undefined);
    snapshotPageStub.mockResolvedValue(PRE);
    vi.mocked(createBrowserSession).mockReset();
    const session = { on: (): void => {}, off: (): void => {} };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: (): string => "https://apply.example.com/wizard",
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
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);
    executeStepWithHealingStub.mockImplementation(async (args: unknown) => {
      if ((args as { step: string }).step === SUBMIT)
        throw new StepVerificationError("submit failed", "cascade-exhausted");
      return "ok";
    });
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
  });

  it("credits a late body re-render once and runs each step exactly once, with no earlier fill re-run", async () => {
    const lateBody = { ...FLIPPED, bodyHtmlLength: 600, visibleTextDigest: "late" };
    // reads: [0] fill start, [1] submit start, then settled reads for the submit
    let reads = 0;
    snapshotPageStub.mockImplementation(async () => {
      reads += 1;
      if (reads <= 2) return PRE;
      return reads <= 4 ? FLIPPED : lateBody;
    });
    process.argv = argv();

    await main();

    expect(guardedObserveStub).not.toHaveBeenCalled();
    expect(generateObjectStub).not.toHaveBeenCalled();
    expect(executedInstructions()).toEqual([FILL_EMAIL, SUBMIT, TAIL]);
    const credits = loggerStub.info.mock.calls.filter(([m]) => String(m).includes(ADVANCE_LOG));
    expect(credits).toHaveLength(1);
  });

  it("still replans a genuinely unadvanced submit step", async () => {
    guardedObserveStub.mockRejectedValue(new Error("replan entered"));
    process.argv = argv();

    await main().catch(() => undefined);

    expect(guardedObserveStub).toHaveBeenCalled();
    expect(loggerStub.info).not.toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });
});
