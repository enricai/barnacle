/**
 * Acceptance regression pinning the reported failure mode: a submitStep-
 * flagged step's cascade throws a judge-rejected StepVerificationError, and
 * the live page has moved to a generic non-success destination (e.g. a
 * sign-in page) rather than the flow's configured success destination. The
 * origin/path-only `hasPageAlreadyAdvancedPastStep` short-circuit must not
 * silently credit the step as completed on that basis — the run must fall
 * through to the replan dispatcher (or an equivalent non-silent failure
 * path) instead.
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

// `replanRemainingFlow`'s first async call is `guardedObserve` — mocking it
// gives a reliable, cheap signal for whether the replan dispatcher's LLM
// path was ever entered, without needing to stub the full Anthropic
// `client.messages.parse` chain replanRemainingFlow drives internally.
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

const SHORT_CIRCUIT_LOG_FRAGMENT =
  "verification failed but the page already advanced past this step";

describe("recon-browser/main — submit-shaped step short-circuit gate acceptance regression", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-submit-shortcircuit-gate-"));
    process.env.RECON_RUN_ID = "20260908-000000-submitshortcircuitgate";
    process.env.RECON_OUT_DIR = runsRoot;
    executeStepWithHealingStub.mockReset();
    guardedObserveStub.mockReset();
    generateObjectStub.mockReset();
    loggerStub.info.mockReset();
    vi.mocked(createBrowserSession).mockReset();
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
    executeStepWithHealingStub.mockReset();
    guardedObserveStub.mockReset();
  });

  it("does not credit a submitStep as completed when the judge rejects it and the page lands on an unrelated sign-in page", async () => {
    // Step 0 is flagged submitStep: true (an order-placement action). Its
    // cascade throws a judge-rejected StepVerificationError, and by the time
    // the catch block reads the live URL the page has landed on a generic
    // "/sign-in" page — not the flow's configured success destination, and
    // not even the same section of the site. The bare origin/path-only
    // short-circuit signal (a same-origin path change) is present here too,
    // which is exactly what must NOT be enough to silently credit the step.
    const urlSequence = [
      "https://shop.example.com/checkout/review",
      "https://shop.example.com/checkout/review",
      "https://shop.example.com/checkout/review",
      "https://shop.example.com/checkout/review", // pre-step read for step 0
      "https://shop.example.com/sign-in", // post-failure read for step 0 (unrelated destination)
    ];
    let urlIndex = 0;
    const session = {
      on: (): void => {},
      off: (): void => {},
    };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: (): string => {
        const url = urlSequence[Math.min(urlIndex, urlSequence.length - 1)]!;
        urlIndex += 1;
        return url;
      },
      title: vi.fn().mockResolvedValue("Checkout"),
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

    executeStepWithHealingStub.mockImplementation(async () => {
      throw new StepVerificationError(
        "submit destination judge rejected: order was not placed",
        "cascade-exhausted"
      );
    });
    guardedObserveStub.mockResolvedValue([]);
    generateObjectStub.mockResolvedValue({ object: { steps: [] } });

    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://shop.example.com/checkout/review",
      "--flow",
      JSON.stringify({
        steps: [
          {
            step: "Click the Place Order button to submit the order",
            optional: false,
            upload: false,
            submitStep: true,
          },
        ],
      }),
    ];

    // The replan dispatcher can't recover from an empty replanned flow, so
    // the run ultimately rejects — what this test pins is that the replan
    // dispatcher's LLM path was reached at all (proving the short-circuit
    // was gated off for this submitStep), not that replan succeeds.
    await expect(main()).rejects.toThrow();

    expect(guardedObserveStub).toHaveBeenCalled();
    expect(loggerStub.info).not.toHaveBeenCalledWith(
      expect.stringContaining(SHORT_CIRCUIT_LOG_FRAGMENT)
    );
  });
});
