/**
 * Acceptance coverage for the post-failure settled advance in recon-browser: a
 * time-scripted page flips its header at once and re-renders its body 8s later
 * with zero counted network. The failed mid-flow submit step is credited from
 * the step-start baseline without a replan re-fill, and a non-submit no-op
 * click still gives up after one poll.
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

import { QUIESCENT_NO_OP_GIVE_UP_MS, settleAfterClick } from "@/scraper/click-settle";
import { StepVerificationError } from "@/scraper/errors";
import { readMidFlowPostClickAdvance } from "@/scraper/flow-runner";
import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";

const CHROME = "Site header nav footer links ".repeat(10);
const PRE = {
  networkCount: 0,
  url: "https://apply.example.com/wizard",
  bodyHtmlLength: 1000,
  visibleTextSignature: `300:Personal info ${CHROME}`,
  visibleText: `Personal info ${CHROME}`,
  visibleTextDigest: "a",
};
const HEADER_FLIPPED = {
  ...PRE,
  visibleTextSignature: `300:Work history ${CHROME}`,
  visibleText: `Work history ${CHROME}`,
  visibleTextDigest: "b",
};
const BODY_RERENDERED = {
  ...HEADER_FLIPPED,
  bodyHtmlLength: 600,
  visibleTextSignature: `188:Work history Add your employers`,
  visibleText: "Work history Add your employers",
  visibleTextDigest: "late",
};
const LATE_BODY_MS = 8000;
const ADVANCE_LOG = "verification failed but the page already advanced past this step";

/** Virtual clock: the header flips at once, the body re-renders at LATE_BODY_MS. */
function pageAt(now: number): typeof PRE {
  return now >= LATE_BODY_MS ? BODY_RERENDERED : HEADER_FLIPPED;
}

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

describe("recon-browser/main — post-failure settled advance with a late body re-render", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;
  let now: number;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-post-failure-advance-"));
    process.env.RECON_RUN_ID = "20261022-000000-postfailureadvance";
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
    now = 0;
    let reads = 0;
    snapshotPageStub.mockImplementation(async () => {
      reads += 1;
      return reads === 1 ? PRE : pageAt(now);
    });
    settleStub.mockImplementation(async () => {
      now += QUIESCENT_NO_OP_GIVE_UP_MS;
    });
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

  it("credits the step once the body re-renders past the first quiet window, without a replan re-fill", async () => {
    process.argv = argv(["Click the Submit button", "Fill in field 1"]);

    await main();

    expect(now).toBeGreaterThanOrEqual(LATE_BODY_MS);
    expect(guardedObserveStub).not.toHaveBeenCalled();
    expect(generateObjectStub).not.toHaveBeenCalled();
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);
    expect(loggerStub.info).toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });

  it("credits an explicit submitStep the same way", async () => {
    process.argv = argv([{ step: "Fill in field 0", submitStep: true }, "Fill in field 1"]);

    await main();

    expect(guardedObserveStub).not.toHaveBeenCalled();
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);
    expect(loggerStub.info).toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });
});

describe("readMidFlowPostClickAdvance — time-scripted page, zero counted network", () => {
  function scriptedTarget(clock: {
    now: number;
  }): Parameters<typeof readMidFlowPostClickAdvance>[0]["target"] {
    return {
      evaluate: async (expr: string): Promise<unknown> => {
        if (expr.includes("__settleQ"))
          return { pending: 0, mutations: clock.now >= LATE_BODY_MS ? 1 : 0 };
        const snap = pageAt(clock.now);
        return {
          html: snap.bodyHtmlLength,
          text: snap.visibleTextSignature,
          full: snap.visibleText,
          digest: snap.visibleTextDigest,
          values: "",
          state: "",
        };
      },
      url: async (): Promise<string> => PRE.url,
    } as never;
  }

  it("credits a header flip whose body lands after the first quiet window", async () => {
    const clock = { now: 0 };
    const page = {
      waitForTimeout: async (ms: number): Promise<void> => {
        clock.now += ms;
      },
    } as unknown as Page;

    const result = await readMidFlowPostClickAdvance({
      target: scriptedTarget(clock),
      signalCounter: { n: 0 },
      page,
      pre: PRE as never,
      stepStartSnapshot: PRE as never,
      midFlowSubmit: true,
    });

    expect(result.pageAdvanced).toBe(true);
    expect(result.post.visibleTextDigest).toBe("late");
  });

  it("does not credit an unmoved page", async () => {
    const clock = { now: 0 };
    const page = {
      waitForTimeout: async (ms: number): Promise<void> => {
        clock.now += ms;
      },
    } as unknown as Page;
    const target = {
      evaluate: async (expr: string): Promise<unknown> =>
        expr.includes("__settleQ")
          ? { pending: 0, mutations: 0 }
          : {
              html: PRE.bodyHtmlLength,
              text: PRE.visibleTextSignature,
              full: PRE.visibleText,
              digest: PRE.visibleTextDigest,
              values: "",
              state: "",
            },
      url: async (): Promise<string> => PRE.url,
    } as never;

    const result = await readMidFlowPostClickAdvance({
      target,
      signalCounter: { n: 0 },
      page,
      pre: PRE as never,
      stepStartSnapshot: PRE as never,
      midFlowSubmit: true,
    });

    expect(result.pageAdvanced).toBe(false);
  });

  it("gives a non-submit no-op click one poll before returning", async () => {
    let waited = 0;
    await settleAfterClick(
      {
        waitForTimeout: async (ms: number): Promise<void> => {
          waited += ms;
        },
      },
      { n: 0 },
      0,
      false,
      async () => PRE.visibleTextSignature,
      PRE.visibleTextSignature,
      async () => ({ pending: 0, mutations: 0 })
    );

    expect(waited).toBe(1000);
  });
});
