/**
 * Acceptance coverage for the recon-browser pre-replan short-circuit: a failed
 * mid-flow submit-shaped step whose settled post-state shows a header flip
 * (element-inferred or explicit submitStep) is credited via the shared settled
 * advance judgement instead of a global replan; an unchanged page still replans.
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
    settleAndSnapshotPostClick: settleStub,
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
  settled: true,
};
const ADVANCE_LOG = "verification failed but the page already advanced past this step";

function argv(steps: unknown[]): string[] {
  return [
    "node",
    "recon-browser.ts",
    "--url",
    "https://apply.example.com/wizard",
    "--flow",
    JSON.stringify({ steps }),
  ];
}

describe("recon-browser/main — settled header-flip pre-replan short-circuit", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-settled-advance-"));
    process.env.RECON_RUN_ID = "20261017-000000-settledadvance";
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
    let calls = 0;
    executeStepWithHealingStub.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new StepVerificationError("step 0 failed", "cascade-exhausted");
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

  it("short-circuits an element-inferred submit step (submitStep unset) on a settled header flip", async () => {
    settleStub.mockResolvedValue(FLIPPED);
    process.argv = argv(["Click the Submit button", "Fill in field 1"]);

    await main();

    expect(guardedObserveStub).not.toHaveBeenCalled();
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);
    expect(loggerStub.info).toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });

  it("short-circuits an explicit submitStep step on a settled header flip", async () => {
    settleStub.mockResolvedValue(FLIPPED);
    process.argv = argv([{ step: "Fill in field 0", submitStep: true }, "Fill in field 1"]);

    await main();

    expect(guardedObserveStub).not.toHaveBeenCalled();
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);
    expect(loggerStub.info).toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });

  it("does not short-circuit a header flip that has not settled", async () => {
    settleStub.mockResolvedValue({ ...FLIPPED, settled: false });
    guardedObserveStub.mockRejectedValue(new Error("replan entered"));
    process.argv = argv(["Click the Submit button", "Fill in field 1"]);

    await main().catch(() => undefined);

    expect(guardedObserveStub).toHaveBeenCalled();
    expect(loggerStub.info).not.toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });

  it("still replans when the settled page shows no advance", async () => {
    settleStub.mockResolvedValue({ ...PRE, settled: true });
    guardedObserveStub.mockRejectedValue(new Error("replan entered"));
    process.argv = argv(["Click the Submit button", "Fill in field 1"]);

    await main().catch(() => undefined);

    expect(guardedObserveStub).toHaveBeenCalled();
    expect(loggerStub.info).not.toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });
});
