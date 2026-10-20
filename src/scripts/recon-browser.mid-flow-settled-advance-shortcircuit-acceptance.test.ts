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

/** Step-start read first, then every settled read the short-circuit makes. */
function snapshotsAfterStart(start: unknown, after: (n: number) => unknown): void {
  let reads = 0;
  snapshotPageStub.mockImplementation(async () => {
    reads += 1;
    return reads === 1 ? start : after(reads - 1);
  });
}
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

let currentUrl = "https://apply.example.com/wizard";

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
    settleStub.mockResolvedValue(undefined);
    snapshotPageStub.mockResolvedValue(PRE);
    currentUrl = "https://apply.example.com/wizard";
    vi.mocked(createBrowserSession).mockReset();
    const session = { on: (): void => {}, off: (): void => {} };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: (): string => currentUrl,
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
    snapshotsAfterStart(PRE, () => FLIPPED);
    process.argv = argv(["Click the Submit button", "Fill in field 1"]);

    await main();

    expect(guardedObserveStub).not.toHaveBeenCalled();
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);
    expect(loggerStub.info).toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });

  it("short-circuits an explicit submitStep step on a settled header flip", async () => {
    snapshotsAfterStart(PRE, () => FLIPPED);
    process.argv = argv([{ step: "Fill in field 0", submitStep: true }, "Fill in field 1"]);

    await main();

    expect(guardedObserveStub).not.toHaveBeenCalled();
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);
    expect(loggerStub.info).toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });

  it("short-circuits an explicit mid-flow submitStep whose URL path advanced", async () => {
    let calls = 0;
    executeStepWithHealingStub.mockImplementation(async () => {
      calls += 1;
      if (calls > 1) return "ok";
      currentUrl = "https://apply.example.com/wizard/work-history";
      throw new StepVerificationError("step 0 failed", "cascade-exhausted");
    });
    process.argv = argv([{ step: "Fill in field 0", submitStep: true }, "Fill in field 1"]);

    await main();

    expect(guardedObserveStub).not.toHaveBeenCalled();
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);
    expect(loggerStub.info).toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });

  const sig = (len: number, text: string): string => `${len}:${text}`;
  it.each([
    {
      name: "header flips, body shrinks ~41%",
      step: "Click the 'Create Account' button to submit the account creation form",
      pre: sig(996, `Sign In ${"Email Address Password Verify New Password. ".repeat(4)}`),
      post: sig(588, `My Account ${"Welcome aboard, verify your inbox to continue. ".repeat(4)}`),
    },
    {
      name: "body grows, different wording",
      step: "Press the 'Register' button to submit the sign-up form",
      pre: sig(120, "Join today Short blurb"),
      post: sig(900, `Verify ${"Check your inbox for the code we sent. ".repeat(5)}`),
    },
    {
      name: "same length, visible text swapped entirely",
      step: "Click 'Sign Up' to submit the registration",
      pre: sig(300, `Enter email ${"alpha beta gamma delta epsilon ".repeat(6)}`),
      post: sig(304, `Welcome back ${"orange purple yellow silver bronze ".repeat(6)}`),
    },
  ])("credits a body swap without a settled flag: $name", async ({ step, pre, post }) => {
    snapshotsAfterStart({ ...PRE, visibleTextSignature: pre, visibleTextDigest: "a" }, () => ({
      ...PRE,
      visibleTextSignature: post,
      visibleTextDigest: "b",
    }));
    process.argv = argv([{ step, submitStep: true }, "Fill in field 1"]);

    await main();

    expect(guardedObserveStub).not.toHaveBeenCalled();
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);
    expect(loggerStub.info).toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });

  it("credits a header flip whose body re-renders late, without replanning", async () => {
    const lateBody = { ...FLIPPED, bodyHtmlLength: 600, visibleTextDigest: "late" };
    snapshotsAfterStart(PRE, (n) => (n <= 2 ? FLIPPED : lateBody));
    process.argv = argv(["Click the Submit button", "Fill in field 1"]);

    await main();

    expect(guardedObserveStub).not.toHaveBeenCalled();
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);
    expect(loggerStub.info).toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });

  it("credits an advance without replanning when the step-start read failed and the baseline arrives via callback", async () => {
    let reads = 0;
    snapshotPageStub.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) throw new Error("step-start snapshot failed");
      return FLIPPED;
    });
    let calls = 0;
    executeStepWithHealingStub.mockImplementation(async (args: unknown) => {
      calls += 1;
      if (calls > 1) return "ok";
      (args as { onElementStepStartBaseline?: (s: unknown) => void }).onElementStepStartBaseline?.(
        PRE
      );
      throw new StepVerificationError("step 0 failed", "cascade-exhausted");
    });
    process.argv = argv(["Click the Submit button", "Fill in field 1"]);

    await main();

    expect(guardedObserveStub).not.toHaveBeenCalled();
    expect(generateObjectStub).not.toHaveBeenCalled();
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);
    expect(loggerStub.info).toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });

  it("does not short-circuit a header flip that has not settled", async () => {
    snapshotsAfterStart(PRE, (n) => ({ ...FLIPPED, visibleTextDigest: `moving-${n}` }));
    guardedObserveStub.mockRejectedValue(new Error("replan entered"));
    process.argv = argv(["Click the Submit button", "Fill in field 1"]);

    await main().catch(() => undefined);

    expect(guardedObserveStub).toHaveBeenCalled();
    expect(loggerStub.info).not.toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });

  it("still replans when the settled page shows no advance", async () => {
    snapshotsAfterStart(PRE, () => PRE);
    guardedObserveStub.mockRejectedValue(new Error("replan entered"));
    process.argv = argv(["Click the Submit button", "Fill in field 1"]);

    await main().catch(() => undefined);

    expect(guardedObserveStub).toHaveBeenCalled();
    expect(loggerStub.info).not.toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });
});
