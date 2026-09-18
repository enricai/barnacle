import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-captcha-solve-real-poll-timeout-continues-acceptance-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-captcha-solve-real-poll-timeout-continues-acceptance-")
);
vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      scraper: { ...actual.config.scraper, twoCaptchaApiKey: "test-2captcha-key" },
    },
  };
});

// Tracks which createTask (`/in.php`) call is currently being polled so the
// `/res.php` responder can drive the FIRST 2Captcha task to CAPCHA_NOT_READY
// for its entire real poll budget (exercising the actual pRetry(24, 5000)
// loop in captcha-solver.ts), then let the SECOND task resolve immediately —
// mirroring the create+poll+create+poll shape solveViaTwoCaptcha actually
// issues, rather than stubbing solveCaptcha's return value directly.
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

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

/**
 * Acceptance-level pin for Signature D (v54ai/v54aj/v54ak) at the DEEPER
 * layer than flow-runner.captcha-solve-timeout-continues-retry-acceptance.test.ts:
 * that file mocks `@/scraper/captcha-solver` entirely and has `solveCaptcha`
 * reject synchronously, so it never exercises the real pRetry(24, 5000) poll
 * loop inside `solveViaTwoCaptcha`. This test mocks only the HTTP layer
 * (`undici`'s `fetch`, the seam `solveCaptcha` itself is built on) so the
 * real poll loop runs to full exhaustion on the first scripted attempt over
 * its real ~120s budget (driven by fake timers), and confirms the run still
 * continues to the next scripted attempt with no unhandled rejection.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function baseParams(
  page: Page,
  stagehand: Stagehand
): Parameters<typeof executeStepWithHealing>[0] {
  return {
    stagehand,
    page,
    step: "Solve the captcha and submit the application",
    optional: false,
    upload: false,
    submitStep: true,
    captchaGated: true,
    flowHasSubmitSemantics: true,
    stepIndex: 0,
    phase: "apply",
    signalCounter: { n: 0 },
    recentCaptures: [] as string[],
    recentCaptureMeta: [] as { method: string; status: number; url: string }[],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
    captureFn: vi.fn().mockResolvedValue(undefined),
    uploadFixture: null,
    isFinalStep: true,
    submitEndpointPattern: null,
    submittedStateSelectors: [] as string[],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: "type=next",
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
  };
}

function makeSuccessfulPage(capturesDir: string): Page {
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

  writeFileSync(
    join(capturesDir, "001-submit-real.json"),
    JSON.stringify({
      requestPostData: "type=next&step=review",
      variables: { input: { type: "next" } },
    })
  );

  return {
    evaluate,
    url: () => "https://apply.example.com/application/abc-123",
    title: vi.fn().mockResolvedValue(""),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi
      .fn()
      .mockImplementation((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
  } as unknown as Page;
}

describe("flow-runner/executeStepWithHealing — real 2Captcha poll-exhaustion timeout continues scripted retry (Signature D, HTTP-layer acceptance)", () => {
  let capturesDir: string;
  let unhandledRejections: unknown[];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };

  beforeAll(() => {
    capturesDir = resolveReconRunDir().graphqlDir;
  });

  beforeEach(() => {
    fetchImplMock.mockClear();
    (testLogger.info as ReturnType<typeof vi.fn>).mockClear();
    (testLogger.error as ReturnType<typeof vi.fn>).mockClear();
    rmSync(capturesDir, { recursive: true, force: true });
    mkdirSync(capturesDir, { recursive: true });
    unhandledRejections = [];
    process.on("unhandledRejection", onUnhandledRejection);
  });

  it("a real poll-exhaustion timeout on attempt 1/3 continues to attempt 2/3, which resolves — no unhandled rejection", async () => {
    const page = makeSuccessfulPage(capturesDir);
    const stagehand = {} as Stagehand;

    vi.useFakeTimers();
    const resultPromise = executeStepWithHealing(baseParams(page, stagehand));
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();
    process.off("unhandledRejection", onUnhandledRejection);

    expect(result).toBe("completed");
    expect(unhandledRejections).toEqual([]);
    // 1 createTask + 25 polls (POLL_MAX_ATTEMPTS=24 retries -> 25 total
    // attempts) for the exhausted first task, then 1 createTask + 1 poll
    // for the immediately-successful second task.
    const inPhpCalls = fetchImplMock.mock.calls.filter(([url]) =>
      (url as string).endsWith("/in.php")
    );
    const resPhpCalls = fetchImplMock.mock.calls.filter(([url]) =>
      (url as string).endsWith("/res.php")
    );
    expect(inPhpCalls).toHaveLength(2);
    expect(resPhpCalls).toHaveLength(26);
    expect(testLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("solve failed on attempt 1/3 (2captcha task not ready yet); retrying")
    );
  }, 30000);
});
