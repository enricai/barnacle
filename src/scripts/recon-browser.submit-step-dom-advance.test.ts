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
    return reads === 1 && start !== undefined
      ? start
      : after(start === undefined ? reads : reads - 1);
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
import { hasSubmitStepDomAdvanced } from "@/scraper/phantom-click";
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

const SIG_PRE = `40:${"Personal info first name last name ".slice(0, 36)}`;
const SIG_POST = `900:Work history employer title start date end date`;

describe("hasSubmitStepDomAdvanced", () => {
  it("credits a non-final step whose text advanced", () => {
    expect(hasSubmitStepDomAdvanced(false, SIG_PRE, SIG_POST)).toBe(true);
  });
  it("never credits a final step", () => {
    expect(hasSubmitStepDomAdvanced(true, SIG_PRE, SIG_POST)).toBe(false);
  });
  it("does not credit an unchanged page", () => {
    expect(hasSubmitStepDomAdvanced(false, SIG_PRE, SIG_PRE)).toBe(false);
  });
  it("fails closed when a signature is missing", () => {
    expect(hasSubmitStepDomAdvanced(false, undefined, SIG_POST)).toBe(false);
  });
  it("credits the settled snapshot after the body re-rendered past the first one", () => {
    const settled = `1200:Work history employer title start date end date`;
    expect(hasSubmitStepDomAdvanced(false, SIG_PRE, settled)).toBe(true);
  });
  it("does not credit a settled page that returned to the step-start text", () => {
    expect(hasSubmitStepDomAdvanced(false, SIG_PRE, `${SIG_PRE}`)).toBe(false);
  });
  it("does not credit a small inline-validation text change", () => {
    const withError = `${SIG_PRE.replace(/^40:/, "52:")}`;
    expect(hasSubmitStepDomAdvanced(false, SIG_PRE, withError)).toBe(false);
  });
  it("credits a header-only flip once the snapshot is marked settled", () => {
    const chrome = "Site header nav footer links ".repeat(10);
    const pre = { visibleTextSignature: `300:Personal info ${chrome}`, visibleTextDigest: "a" };
    const post = { visibleTextSignature: `300:Work history ${chrome}`, visibleTextDigest: "b" };
    expect(hasSubmitStepDomAdvanced(false, pre, { ...post, settled: true })).toBe(true);
    expect(hasSubmitStepDomAdvanced(true, pre, { ...post, settled: true })).toBe(false);
  });
  it("does not credit a header-only flip while the snapshot is unsettled", () => {
    const chrome = "Site header nav footer links ".repeat(10);
    const pre = { visibleTextSignature: `300:Personal info ${chrome}`, visibleTextDigest: "a" };
    const post = { visibleTextSignature: `300:Work history ${chrome}`, visibleTextDigest: "b" };
    expect(hasSubmitStepDomAdvanced(false, pre, post)).toBe(false);
    expect(hasSubmitStepDomAdvanced(false, pre, { ...post, settled: false })).toBe(false);
  });
  it("credits the step-start versus settled report pair, never on a final step", () => {
    const pre = "996:Skip to main content|Sign In|Careers Home|Back to Job Posting";
    const post = "588:Skip to main content|Settings|user@example.com|Careers Home|Candidate Home";
    expect(
      hasSubmitStepDomAdvanced(false, pre, { visibleTextSignature: post, settled: true })
    ).toBe(true);
    expect(hasSubmitStepDomAdvanced(false, pre, post)).toBe(true);
    expect(hasSubmitStepDomAdvanced(true, pre, { visibleTextSignature: post, settled: true })).toBe(
      false
    );
  });
  it("does not credit an identical settled pair", () => {
    expect(
      hasSubmitStepDomAdvanced(false, SIG_PRE, { visibleTextSignature: SIG_PRE, settled: true })
    ).toBe(false);
  });
  it("credits a late advance against the element-shaped step-start baseline when textAtStepStart is absent", () => {
    const chrome = "Site header nav footer links ".repeat(10);
    const textAtStepStart = undefined;
    const elementBaseline = {
      visibleTextSignature: `300:Personal info ${chrome}`,
      visibleTextDigest: "a",
    };
    const baselineText = textAtStepStart ?? elementBaseline;
    const settled = {
      visibleTextSignature: `300:Work history ${chrome}`,
      visibleTextDigest: "b",
      settled: true,
    };
    expect(hasSubmitStepDomAdvanced(false, baselineText, settled)).toBe(true);
    expect(hasSubmitStepDomAdvanced(false, textAtStepStart, settled)).toBe(false);
    expect(hasSubmitStepDomAdvanced(true, baselineText, settled)).toBe(false);
  });
  it("does not credit the element-shaped baseline when the page never advanced", () => {
    const elementBaseline = { visibleTextSignature: SIG_PRE, visibleTextDigest: "a" };
    const settled = { ...elementBaseline, settled: true };
    expect(hasSubmitStepDomAdvanced(false, elementBaseline, settled)).toBe(false);
  });
});

describe("recon-browser/main — resolved-element step-start baseline", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-element-baseline-"));
    process.env.RECON_RUN_ID = "20261017-000000-elementbaseline";
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
    executeStepWithHealingStub.mockImplementation(async (args: unknown) => {
      calls += 1;
      if (calls === 1) {
        (
          args as { onElementStepStartBaseline?: (s: unknown) => void }
        ).onElementStepStartBaseline?.(PRE);
      }
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

  it("credits a late advance on a non-submit-worded step via the resolved-element baseline", async () => {
    const lateBody = { ...FLIPPED, bodyHtmlLength: 600, visibleTextDigest: "late" };
    snapshotsAfterStart(undefined, (n) => (n <= 1 ? FLIPPED : lateBody));
    process.argv = argv(["Fill in field 0", "Fill in field 1"]);

    await main();

    expect(guardedObserveStub).not.toHaveBeenCalled();
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);
    expect(loggerStub.info).toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });

  it("still replans when the page never advanced from the resolved-element baseline", async () => {
    snapshotsAfterStart(undefined, () => PRE);
    guardedObserveStub.mockRejectedValue(new Error("replan entered"));
    process.argv = argv(["Fill in field 0", "Fill in field 1"]);

    await main().catch(() => undefined);

    expect(guardedObserveStub).toHaveBeenCalled();
    expect(loggerStub.info).not.toHaveBeenCalledWith(expect.stringContaining(ADVANCE_LOG));
  });
});
