/**
 * Integration-level pin for Signature D (v54ai/v54aj/v54ak): a mid-retry
 * 2Captcha solve timeout hard-aborting the whole `recon-browser` run instead
 * of continuing to the next scripted attempt.
 *
 * `flow-runner.captcha-solve-real-poll-timeout-continues-retry-acceptance.test.ts`
 * already proves `executeStepWithHealing`'s own retry loop is correct in
 * isolation by calling it directly. This test drives the real production
 * path instead — `recon-browser.ts`'s unstubbed `main()`/step loop (session
 * wrapping via `createBrowserSession`, `raceAgainstTeardown`,
 * `dumpStepFailure`) around the SAME unstubbed `executeStepWithHealing` —
 * mocking only the HTTP layer (`undici`'s `fetch`, the seam `solveCaptcha`
 * is built on) so the real `pRetry(24, 5000)` poll loop in
 * `captcha-solver.ts` runs to full exhaustion on the first scripted attempt,
 * reproducing the exact `CaptchaError("2captcha task not ready yet")`
 * the report's top-level `recon-browser failed: ...` message quotes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Tracks which createTask (`/in.php`) call is currently being polled so the
// `/res.php` responder can drive the FIRST 2Captcha task to CAPCHA_NOT_READY
// for its entire real poll budget (exercising the actual pRetry(24, 5000)
// loop in captcha-solver.ts), then let the SECOND task resolve immediately —
// mirroring solveViaTwoCaptcha's real create+poll+create+poll call shape
// instead of stubbing solveCaptcha's return value directly.
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
              : { status: 1, request: "solved-token-real-poll" }
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

import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";
import { resolveReconRunDir } from "@/scripts/recon-shared";

const BASE_URL = "https://portal.example.net/app/checkout";
const CAPTCHA_STEP = "Click the 'Continue' button to submit the application";

function flowArgv(): string[] {
  return [
    "node",
    "recon-browser.ts",
    "--url",
    BASE_URL,
    "--flow",
    JSON.stringify({
      steps: [{ step: CAPTCHA_STEP, captchaGated: true, submitStep: true }],
      advanceTransitionBodyPattern: "type=next",
    }),
  ];
}

function makePage(): Page {
  const session = { on: (): void => {}, off: (): void => {} };
  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("hasForm")) {
      return { injected: true, hasForm: true, callbackDiscovered: false };
    }
    if (src.includes('return "absent"')) return "populated";
    if (src.includes("getAttribute")) {
      return { siteKey: "10000000-ffff-ffff-ffff-000000000001", isInvisible: true };
    }
    if (src === "navigator.userAgent") return "test-agent/1.0";
    if (src.includes("dispatchEvent")) return undefined;
    if (src.includes("requestSubmit")) return undefined;
    if (src.includes("outerHTML")) return { html: 0, text: "0:" };
    if (src.includes("isInvalid(el)")) return 0;
    return null;
  });

  return {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate,
    url: () => BASE_URL,
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
}

describe("recon-browser/main — real 2Captcha poll-exhaustion timeout continues scripted retry through the production step loop (Signature D)", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;
  let unhandledRejections: unknown[];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-captcha-solve-timeout-mid-retry-"));
    process.env.RECON_RUN_ID = "20260918-000000-captchamidretry";
    process.env.RECON_OUT_DIR = runsRoot;
    fetchImplMock.mockClear();
    loggerStub.info.mockClear();
    loggerStub.warn.mockClear();
    loggerStub.error.mockClear();
    vi.mocked(createBrowserSession).mockReset();
    unhandledRejections = [];
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
  });

  it("a real poll-exhaustion timeout on attempt 1/3 does not abort the process — it proceeds to attempt 2/3 which resolves", async () => {
    const page = makePage();
    const stagehand = {
      context: { awaitActivePage: async (): Promise<Page> => page },
    } as unknown as Stagehand;

    // A real Browserbase session always carries a `deathSignal` (see
    // `createSessionTeardownDetector` in `session-teardown.ts`), which routes
    // every step through `raceAgainstTeardown` — omitting it here would skip
    // that race entirely and leave it unexercised, silently narrowing this
    // "integration" test back down to the same seam the local flow-runner
    // unit tests already cover. A session that never tears down mid-flow
    // never signals death, so this promise legitimately never settles.
    const deathSignal = new Promise<never>(() => {});
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
      deathSignal,
    } as never);

    process.argv = flowArgv();

    // Seeds the disk-backed capture window `waitForTransitionBody` polls so
    // the post-submit transition on the (eventually) successful attempt is
    // confirmed, mirroring the real-poll flow-runner acceptance test's setup.
    const capturesDir = resolveReconRunDir().graphqlDir;
    mkdirSync(capturesDir, { recursive: true });
    writeFileSync(
      join(capturesDir, "001-submit-real.json"),
      JSON.stringify({
        requestPostData: "type=next&step=review",
        variables: { input: { type: "next" } },
      })
    );

    vi.useFakeTimers();
    const runPromise = main();
    await vi.runAllTimersAsync();
    await expect(runPromise).resolves.toBeUndefined();
    vi.useRealTimers();

    // The reported hard-abort never happens: no unhandled rejection, and no
    // `recon-browser failed: ...` top-level error is logged.
    expect(unhandledRejections).toEqual([]);
    const allErrors = loggerStub.error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allErrors).not.toContain("recon-browser failed");

    // The report's exact "solve failed on attempt 1/3 ... retrying" line
    // fires, proving the timeout was hit and absorbed rather than escaping.
    expect(allErrors).toContain(
      "solve failed on attempt 1/3 (2captcha task not ready yet); retrying"
    );

    // 1 createTask + 25 polls (POLL_MAX_ATTEMPTS=24 -> 25 total attempts) for
    // the exhausted first task, then 1 createTask + 1 poll for the
    // immediately-successful second task.
    const inPhpCalls = fetchImplMock.mock.calls.filter(([url]) =>
      (url as string).endsWith("/in.php")
    );
    const resPhpCalls = fetchImplMock.mock.calls.filter(([url]) =>
      (url as string).endsWith("/res.php")
    );
    expect(inPhpCalls).toHaveLength(2);
    expect(resPhpCalls).toHaveLength(26);

    // The run completed via exactly one session — no CDP-transport retry, no
    // exit(1).
    expect(createBrowserSession).toHaveBeenCalledTimes(1);
  }, 30000);
});
