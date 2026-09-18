/**
 * Combined regression-acceptance test proving Signatures B, C, and D still
 * hold, driven through real `main()` runs, now that bugfix-001's
 * disabled/aria-disabled veto has landed in `submit-control.ts`'s
 * rank+click primitives — the same primitives both the captchaGated
 * fallback submit path and the ordinary phantom-click cascade share.
 * Matches this repo's established pattern (see
 * flow-runner.captcha-gated-clean-callback-cascade-regression-acceptance.test.ts's
 * docblock) of adding a single combined test after a change to code shared
 * with prior per-signature fixes, rather than trusting that unrelated
 * per-signature suites weren't quietly broken by it.
 *
 *  1. (Signature B) A replan-spliced bridge step whose wording never
 *     re-quotes the failed control's label still carries
 *     `captchaGated`/`submitStep` deterministically —
 *     `applyFailedStepFlagsToResumingBridgeStep` (src/scripts/recon-browser.ts)
 *     re-applies the flags rather than relying on LLM inference.
 *  2. (Signature D) A real 2Captcha poll-exhaustion timeout on a non-final
 *     attempt logs "retrying" and reaches the next attempt instead of
 *     aborting or producing an unhandled rejection.
 *  3. (Signature C) Two independent `main()` runs against byte-for-byte
 *     identical stuck-step fixtures abort with the same
 *     `StepVerificationError.kind` — the no-progress guard
 *     (`isReplanReproposingFailedStep`) must fire identically both times,
 *     never diverging between "replan cycle detected" and any other exit.
 *
 * A run that regresses any one of these three cannot pass here: reverting
 * the retention fix would skip the bridge step's whole captchaGated block;
 * reverting the poll-timeout tolerance would turn the exhausted first task
 * into an unhandled rejection; and a bugfix-001 veto that somehow altered
 * the shared rank+click primitives' control flow (rather than just which
 * candidates they accept) would make the two structurally-identical stuck
 * runs diverge in their abort kind.
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

// Two of the three test cases stub only the ORIGINAL failing step's outcome
// (a deterministic terminal failure), never the rest of the module — the
// bridge step (Signature B/D case) and every other step fall through to the
// REAL implementation, so the retention fix and the 2Captcha poll-timeout
// tolerance run for real. Signature C's stuck step is stubbed to always
// terminally fail the same way both runs, isolating the assertion to
// `main()`'s own (unstubbed) abort-kind selection rather than depending on
// a second full real cascade run.
const ORIGINAL_STEP = "Click the 'Proceed' button";
const BRIDGE_STEP = "Complete the security check and finalize the request";
const STUCK_STEP = "Click the 'Submit Request' button";

const { executeStepWithHealingSpy, recentCaptureMetaHolder } = vi.hoisted(() => ({
  executeStepWithHealingSpy: vi.fn(),
  recentCaptureMetaHolder: { current: [] as { method: string; status: number; url: string }[] },
}));
vi.mock("@/scraper/flow-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/flow-runner")>();
  return {
    ...actual,
    executeStepWithHealing: vi.fn(
      async (args: Parameters<typeof actual.executeStepWithHealing>[0]) => {
        executeStepWithHealingSpy(args);
        if (args.step === "Click the 'Proceed' button") {
          throw new StepVerificationError(
            `step failed verification: ${args.step}`,
            "cascade-exhausted"
          );
        }
        if (args.step === "Click the 'Submit Request' button") {
          throw new StepVerificationError(
            `step failed verification: ${args.step} (phantom click)`,
            "phantom-click-exhausted"
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
// budget), the SECOND resolves immediately.
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
              : { status: 1, request: "solved-token-postveto" }
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

const BASE_URL = "https://portal.example.net/request/xyz-789";
const STUCK_BASE_URL = "https://portal.example.net/request/stuck-000";

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

function makeFakePage(): { page: Page; stagehand: Stagehand } {
  const session = { on: (): void => {}, off: (): void => {} };
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("hasForm")) {
      return { injected: true, fieldExists: false, hasForm: true, callbackDiscovered: true };
    }
    if (src.includes('return "absent"')) return "populated";
    if (src.includes("deepElements") && src.includes("ranked.sort")) {
      return [{ deepIndex: 0, tier: 3, tag: "button", accessibleName: "submit" }];
    }
    if (src.includes("deepElements") && src.includes("clicked: true")) {
      recentCaptureMetaHolder.current.push({
        method: "POST",
        status: 200,
        url: "https://portal.example.net/api/request/submit",
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
    title: vi.fn().mockResolvedValue("Request"),
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

/** Minimal fixture for Signature C: `executeStepWithHealing` is fully stubbed for STUCK_STEP, so no real cascade internals ever touch `page`. */
function makeStuckPage(): { page: Page; stagehand: Stagehand } {
  const session = { on: (): void => {}, off: (): void => {} };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: (): string => STUCK_BASE_URL,
    title: vi.fn().mockResolvedValue("Request"),
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

describe("recon-browser/main — captchaGated Signatures B/C/D remain intact post-disabled-veto (acceptance)", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-post-veto-regression-"));
    process.env.RECON_RUN_ID = "20260918-000000-postvetoregression";
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

  it("Signatures B + D: retention-spliced bridge step survives a real 2Captcha poll-exhaustion timeout", async () => {
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

    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      BASE_URL,
      "--flow",
      JSON.stringify([{ step: ORIGINAL_STEP, captchaGated: true, submitStep: true }]),
    ];

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
    )?.[0] as { captchaGated: boolean; submitStep: boolean } | undefined;

    expect(bridgeCallArgs).toBeDefined();
    // Signature B: deterministic re-application, not LLM inference — the
    // bridge wording never re-quotes "Proceed" and the mocked replan
    // response never set captchaGated, yet the spliced step still carries it.
    expect(bridgeCallArgs?.captchaGated).toBe(true);
    expect(bridgeCallArgs?.submitStep).toBe(true);

    const inPhpCalls = fetchImplMock.mock.calls.filter(([url]) =>
      (url as string).endsWith("/in.php")
    );
    const resPhpCalls = fetchImplMock.mock.calls.filter(([url]) =>
      (url as string).endsWith("/res.php")
    );
    expect(inPhpCalls).toHaveLength(2);
    expect(resPhpCalls).toHaveLength(26);

    const errorLines = loggerStub.error.mock.calls.map((c) => String(c[0]));
    const infoLines = loggerStub.info.mock.calls.map((c) => String(c[0]));

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
    expect(infoLines.filter((l) => l.includes("recon complete"))).toHaveLength(1);

    expect(recentCaptureMetaHolder.current).toHaveLength(1);
  }, 30_000);

  it("Signature C: two independent main() runs against a byte-identical stuck step abort with the same StepVerificationError.kind", async () => {
    const flowArgv = (): string[] => [
      "node",
      "recon-browser.ts",
      "--url",
      STUCK_BASE_URL,
      "--flow",
      JSON.stringify([{ step: STUCK_STEP, submitStep: true }]),
    ];

    // Run 1
    const { stagehand: stagehand1 } = makeStuckPage();
    vi.mocked(createBrowserSession).mockResolvedValueOnce({
      stagehand: stagehand1,
      limiter: {} as never,
      sessionId: "test-session-1",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);
    // The replan LLM re-proposes the exact same failed step, byte-for-byte —
    // main()'s isReplanReproposingFailedStep no-progress guard must fire
    // immediately rather than resuming a doomed re-run of the same click.
    messagesParseStub.mockResolvedValueOnce(replanResponse(STUCK_STEP));
    process.argv = flowArgv();

    const run1 = await main().then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err })
    );
    expect(run1.ok).toBe(false);
    expect(run1.ok === false && run1.err).toMatchObject({
      name: "StepVerificationError",
      kind: "replan-cycle-detected",
    });

    // Reset per-run mocks (mirrors beforeEach) without touching the module
    // mocks themselves, then run again against the byte-identical fixture.
    executeStepWithHealingSpy.mockClear();
    messagesParseStub.mockReset();
    loggerStub.error.mockClear();
    loggerStub.info.mockClear();

    const { stagehand: stagehand2 } = makeStuckPage();
    vi.mocked(createBrowserSession).mockResolvedValueOnce({
      stagehand: stagehand2,
      limiter: {} as never,
      sessionId: "test-session-2",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);
    messagesParseStub.mockResolvedValueOnce(replanResponse(STUCK_STEP));
    process.argv = flowArgv();

    const run2 = await main().then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err })
    );
    expect(run2.ok).toBe(false);
    expect(run2.ok === false && run2.err).toMatchObject({
      name: "StepVerificationError",
      kind: "replan-cycle-detected",
    });

    // Both runs must select the identical abort signature — never diverging
    // between "replan cycle detected" and any other terminal-abort path.
    const kind1 = run1.ok === false ? (run1.err as { kind: string }).kind : null;
    const kind2 = run2.ok === false ? (run2.err as { kind: string }).kind : null;
    expect(kind1).toBe(kind2);
  });
});
