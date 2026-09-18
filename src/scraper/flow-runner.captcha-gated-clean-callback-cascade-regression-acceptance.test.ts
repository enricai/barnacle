/**
 * Combined regression-acceptance test proving the report's actual shape in a
 * single `main()` run, matching this repo's established pattern of combined
 * acceptance tests added after standalone per-signature fixes previously
 * regressed each other (commits 1c2ca29, f98b2e3):
 *
 *  1. The original step's captchaGated attempt loop exhausts all 3 attempts
 *     (no matchable form on the page at all), driving the step to a
 *     `cascade-exhausted` failure and triggering a global replan.
 *  2. The replan LLM's bridge step carries NO `captchaGated` flag at all —
 *     `applyFailedStepFlagsToResumingBridgeStep` (src/scripts/recon-browser.ts)
 *     must deterministically re-apply it, not rely on LLM inference. This
 *     drives `main()` for real (only `createBrowserSession` and the replan
 *     LLM call are stubbed) with the REAL `executeStepWithHealing` running
 *     for the bridge step, so a reverted retention fix would genuinely skip
 *     the whole captchaGated block below instead of merely failing an
 *     assertion on a stubbed call's arguments.
 *  3. The bridge step's own captchaGated attempt loop reproduces two more
 *     signatures at once: attempt 1/3's `solveCaptcha` call exhausts a REAL
 *     2Captcha poll-timeout (only the HTTP layer — `undici`'s `fetch` — is
 *     mocked, exercising the genuine pRetry(24, 5000ms) loop) and the run
 *     continues to attempt 2/3 instead of aborting; attempt 2/3 solves, and
 *     its clean callback (callbackDiscovered=true, registryState=populated)
 *     has no `advanceTransitionBodyPattern` configured (the flow is declared
 *     as a bare instruction array, so `recon-browser.ts` never sets one) and
 *     the fallback-dispatched submit's response never changes the page's
 *     URL/origin — so the ONLY signature that can confirm the advance is the
 *     post-submit network-capture transition check, not the URL/origin poll.
 *
 * A run that regresses any one of these three fixes cannot reach
 * "completed" here: reverting the retention fix skips the retry/network
 * logic below entirely (the bridge step's captchaGated would read false, so
 * the whole solve loop is bypassed); reverting the poll-timeout tolerance
 * turns the exhausted first task into an unhandled rejection instead of a
 * continued attempt 2; and reverting the network-transition detector leaves
 * the run stuck retrying past attempt 3 and falling through to the ordinary
 * cascade this report says never observed a network-only advance.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      scraper: {
        ...actual.config.scraper,
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
        twoCaptchaApiKey: "test-2captcha-key",
      },
      telemetry: {
        callsNdjsonPath: ".barnacle/calls.ndjson",
      },
    },
  };
});
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

// Only the ORIGINAL step's outcome is scripted (a deterministic
// cascade-exhausted failure, mirroring the report's evidence table). The
// bridge step falls through to the REAL implementation so the retention fix,
// the 2Captcha poll-timeout tolerance, and the network-transition detector
// all run for real, not as stubbed assertions.
const { executeStepWithHealingSpy, recentCaptureMetaHolder } = vi.hoisted(() => ({
  executeStepWithHealingSpy: vi.fn(),
  // main() owns its own internal `recentCaptureMeta` array (constructed
  // inside recon-browser.ts, not something a caller can inject) — this
  // holder lets the page.evaluate fixture below push into the SAME array
  // the real executeStepWithHealing reads from, captured off the real args
  // the moment main() calls through for the bridge step.
  recentCaptureMetaHolder: { current: [] as { method: string; status: number; url: string }[] },
}));
vi.mock("@/scraper/flow-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/flow-runner")>();
  return {
    ...actual,
    executeStepWithHealing: vi.fn(
      async (args: Parameters<typeof actual.executeStepWithHealing>[0]) => {
        executeStepWithHealingSpy(args);
        if (args.step === ORIGINAL_STEP) {
          throw new StepVerificationError(
            `step failed verification: ${ORIGINAL_STEP}`,
            "cascade-exhausted"
          );
        }
        recentCaptureMetaHolder.current = args.recentCaptureMeta as {
          method: string;
          status: number;
          url: string;
        }[];
        return actual.executeStepWithHealing(args);
      }
    ),
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

// Drives the real 2Captcha poll loop inside solveViaTwoCaptcha: the FIRST
// created task never reports ready (exhausting the real pRetry(24, 5000ms)
// budget), the SECOND resolves immediately — mirroring the
// create+poll+create+poll shape solveViaTwoCaptcha actually issues, rather
// than stubbing solveCaptcha's return value directly.
const { fetchImplMock } = vi.hoisted(() => {
  let taskCounter = 0;
  const impl = vi.fn(async (url: string) => {
    if (url.endsWith("/in.php")) {
      taskCounter += 1;
      return {
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({ status: 1, request: `task-${taskCounter}` })),
      };
    }
    return {
      status: 200,
      headers: new Headers(),
      text: () =>
        Promise.resolve(
          JSON.stringify(
            taskCounter === 1
              ? { status: 0, request: "CAPCHA_NOT_READY" }
              : { status: 1, request: "solved-token-bridge" }
          )
        ),
    };
  });
  return { fetchImplMock: impl };
});
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: fetchImplMock };
});

import { StepVerificationError } from "@/scraper/errors";
import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";

const BASE_URL = "https://apply.example.com/application/abc-123";
const ORIGINAL_STEP = "Click the 'Continue' button";
const BRIDGE_STEP = "Solve the captcha and submit the application";

function flowArgv(): string[] {
  return [
    "node",
    "recon-browser.ts",
    "--url",
    BASE_URL,
    "--flow",
    JSON.stringify([{ step: ORIGINAL_STEP, captchaGated: true, submitStep: true }]),
  ];
}

function replanResponse(bridgeStep: string): {
  parsed_output: { outcome: string; steps: string[] };
  content: { type: string; text: string }[];
  usage: { input_tokens: number; output_tokens: number };
} {
  return {
    // Deliberately omits `captchaGated` on the bridge step — the retention
    // this test pins must NOT depend on the mocked LLM output containing it.
    parsed_output: { outcome: "replan", steps: [bridgeStep] },
    content: [{ type: "text", text: "" }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function makeFakePage(): {
  page: Page;
  stagehand: Stagehand;
} {
  const session = { on: (): void => {}, off: (): void => {} };
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    // The widget's own render callback fires cleanly (callbackDiscovered
    // =true), and only the sitekey-anchored form fallback is found
    // (fieldExists=false, hasForm=true).
    if (src.includes("hasForm")) {
      return { injected: true, fieldExists: false, hasForm: true, callbackDiscovered: true };
    }
    if (src.includes('return "absent"')) return "populated";
    if (src.includes("deepElements") && src.includes("ranked.sort")) {
      return [{ deepIndex: 0, tier: 3, tag: "button", accessibleName: "submit" }];
    }
    // The explicit fallback click dispatches a real, same-origin XHR/fetch
    // submit — the response lands in recentCaptureMeta, but the page's
    // URL/origin never changes (no client-side redirect).
    if (src.includes("deepElements") && src.includes("clicked: true")) {
      recentCaptureMetaHolder.current.push({
        method: "POST",
        status: 200,
        url: "https://apply.example.com/api/application/submit",
      });
      return { clicked: true };
    }
    if (src.includes("getAttribute")) {
      return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
    }
    if (src === "navigator.userAgent") return "test-agent/1.0";
    if (src.includes("requestSubmit")) return undefined;
    if (src.includes("fieldForm")) return true;
    if (src.includes("dispatchEvent")) return undefined;
    if (src.includes("outerHTML")) return { html: 0, text: "0:" };
    if (src.includes("isInvalid(el)")) return 0;
    return 10_000;
  });
  const page = {
    evaluate,
    goto: vi.fn().mockResolvedValue(undefined),
    url: (): string => BASE_URL,
    title: vi.fn().mockResolvedValue("Application"),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi
      .fn()
      .mockImplementation((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
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

describe("recon-browser/main — combined captchaGated clean-callback + replan-retention + 2Captcha poll-timeout regression (acceptance)", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-captcha-combined-regression-"));
    process.env.RECON_RUN_ID = "20260918-000000-captchacombinedregression";
    process.env.RECON_OUT_DIR = runsRoot;
    executeStepWithHealingSpy.mockReset();
    guardedObserveStub.mockReset();
    guardedObserveStub.mockResolvedValue([]);
    messagesParseStub.mockReset();
    generateObjectStub.mockReset();
    fetchImplMock.mockClear();
    vi.mocked(createBrowserSession).mockReset();
    loggerStub.info.mockClear();
    loggerStub.warn.mockClear();
    loggerStub.error.mockClear();
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
    executeStepWithHealingSpy.mockReset();
    guardedObserveStub.mockReset();
    messagesParseStub.mockReset();
  });

  it("completes via the real captchaGated retry loop on the retention-spliced bridge step, surviving a real 2Captcha poll-exhaustion timeout and confirming via the network-transition signal alone", async () => {
    recentCaptureMetaHolder.current = [];
    const { stagehand } = makeFakePage();

    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    messagesParseStub.mockResolvedValueOnce(replanResponse(BRIDGE_STEP));

    process.argv = flowArgv();

    vi.useFakeTimers();
    const resultPromise = main();
    await vi.runAllTimersAsync();
    await resultPromise;
    vi.useRealTimers();

    // Exactly one replan: the original step's cascade-exhausted failure.
    expect(messagesParseStub).toHaveBeenCalledTimes(1);
    expect(executeStepWithHealingSpy).toHaveBeenCalledTimes(2);

    const bridgeCallArgs = executeStepWithHealingSpy.mock.calls.find(
      ([args]) => (args as { step: string }).step === BRIDGE_STEP
    )?.[0] as
      | { captchaGated: boolean; submitStep: boolean; advanceTransitionBodyPattern: unknown }
      | undefined;

    expect(bridgeCallArgs).toBeDefined();
    // Deterministic re-application, not LLM inference: the mocked replan
    // response never set captchaGated on the bridge step, yet the spliced
    // step that re-executes carries it.
    expect(bridgeCallArgs?.captchaGated).toBe(true);
    expect(bridgeCallArgs?.submitStep).toBe(true);
    expect(bridgeCallArgs?.advanceTransitionBodyPattern).toBeNull();

    // Real 2Captcha HTTP traffic: 1 createTask + 25 polls (POLL_MAX_ATTEMPTS
    // =24 retries -> 25 total attempts) for the exhausted first task, then 1
    // createTask + 1 poll for the immediately-successful second task.
    const inPhpCalls = fetchImplMock.mock.calls.filter(([url]) =>
      (url as string).endsWith("/in.php")
    );
    const resPhpCalls = fetchImplMock.mock.calls.filter(([url]) =>
      (url as string).endsWith("/res.php")
    );
    expect(inPhpCalls).toHaveLength(2);
    expect(resPhpCalls).toHaveLength(26);

    const infoLines = loggerStub.info.mock.calls.map((c) => String(c[0]));
    const errorLines = loggerStub.error.mock.calls.map((c) => String(c[0]));
    const allLogged = [
      ...infoLines,
      ...loggerStub.warn.mock.calls.map((c) => String(c[0])),
      ...errorLines,
    ].join("\n");

    // Signature D: attempt 1/3's real poll-exhaustion timeout continues to
    // attempt 2/3 rather than aborting the run.
    expect(errorLines).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "solve failed on attempt 1/3 (2captcha task not ready yet); retrying"
        ),
      ])
    );
    expect(infoLines).toEqual(expect.arrayContaining([expect.stringContaining("attempt=2/3")]));

    // Signature A/B: the clean callback with no advanceTransitionBodyPattern
    // is confirmed via the network-capture transition, not the URL/origin
    // poll — the report's "no confirmed transition despite clean callback"
    // gap this whole combined run pins closed.
    expect(allLogged).toContain(
      "captchaGated step: post-submit network response confirmed the advance"
    );
    expect(allLogged).not.toContain(
      "post-submit navigation to a new origin/path confirmed the advance"
    );
    expect(allLogged).not.toContain("with no confirmed transition on attempt");

    // The bridge step never falls through to the ordinary phantom-click
    // cascade — it resolves entirely inside its own captchaGated block, so
    // only the ORIGINAL step's expected replan trigger appears, never a
    // second (budget-exhausted) failure past it.
    expect(allLogged).not.toContain("replan budget exhausted");
    expect(infoLines.filter((l) => l.includes("recon complete"))).toHaveLength(1);

    expect(recentCaptureMetaHolder.current).toHaveLength(1);
  }, 30_000);
});
