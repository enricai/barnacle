/**
 * Regression coverage for bugfix-005: when a step's verification fails but
 * the live page's URL has already moved past where the step started, the
 * step's effect landed even though verification failed to observe it — the
 * deterministic `hasPageAlreadyAdvancedPastStep` short-circuit must skip the
 * replan dispatcher entirely and resume the loop, rather than invoking the
 * LLM replanner (which either re-authors the already-completed step or
 * re-proposes the identical failed step against a page shape it no longer
 * matches).
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

const TOTAL_STEPS = 3;

function flowArgv(stepCount: number): string[] {
  return [
    "node",
    "recon-browser.ts",
    "--url",
    "https://apply.example.com/wizard/step-1",
    "--flow",
    JSON.stringify(Array.from({ length: stepCount }, (_, i) => `Fill in field ${i}`)),
  ];
}

describe("recon-browser/main — replan already-advanced short-circuit (bugfix-005)", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-replan-advanced-"));
    process.env.RECON_RUN_ID = "20260908-000000-replanadvanced";
    process.env.RECON_OUT_DIR = runsRoot;
    executeStepWithHealingStub.mockReset();
    guardedObserveStub.mockReset();
    generateObjectStub.mockReset();
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

  it("skips replan and resumes the tail when verification fails but the page already navigated past the step", async () => {
    // Step 1 (index 0) starts on step-1, fails verification, but by the
    // time the catch block reads the live URL the page has already moved
    // to step-2 — a cross-page navigation, not a same-page query/hash
    // change. Steps 2 and 3 (indices 1, 2) then succeed normally.
    const urlSequence = [
      "https://apply.example.com/wizard/step-1", // pre-step read for step 0
      "https://apply.example.com/wizard/step-2", // post-failure read for step 0 (advanced)
      "https://apply.example.com/wizard/step-2", // pre-step read for step 1
      "https://apply.example.com/wizard/step-2", // post-step read for step 1
      "https://apply.example.com/wizard/step-3", // pre-step read for step 2
      "https://apply.example.com/wizard/step-3", // post-step read for step 2
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

    let stepCount = 0;
    executeStepWithHealingStub.mockImplementation(async () => {
      stepCount += 1;
      if (stepCount === 1) {
        throw new StepVerificationError("step 0 failed verification", "cascade-exhausted");
      }
      return "ok";
    });

    process.argv = flowArgv(TOTAL_STEPS);

    await main();

    // The replan dispatcher's LLM path (guardedObserve is its first async
    // call) must never have been entered for the already-advanced step.
    expect(guardedObserveStub).not.toHaveBeenCalled();
    // The loop must have resumed and run all three steps' healing attempts
    // (one throw for step 0 plus two successful calls for steps 1 and 2).
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(TOTAL_STEPS);
    expect(loggerStub.info).toHaveBeenCalledWith(
      expect.stringContaining("verification failed but the page already advanced past this step")
    );
  });

  it("frame-aware: fires the short-circuit when a same-origin iframe's location advances but the top page.url() never moves", async () => {
    // The flow declares a frameSelector — the wizard lives entirely inside a
    // same-origin iframe, so the top page.url() stays on the shell URL for
    // the whole run. Only the child frame's location.href moves between the
    // pre-step and post-failure reads; a top-page-only comparison (the bug
    // this test pins) would never see that as advancement and would fall
    // through to the replan dispatcher instead of short-circuiting.
    const IFRAME_SRC = "https://apply.example.com/wizard/step-1";
    const frameUrlSequence = [
      "https://apply.example.com/wizard/step-1", // resolveFrameTarget's candidate-scoring probe
      "https://apply.example.com/wizard/step-1", // pre-step read for step 0
      "https://apply.example.com/wizard/step-2", // post-failure read for step 0 (advanced)
    ];
    let frameUrlIndex = 0;
    const session = {
      on: (): void => {},
      off: (): void => {},
    };
    const childFrame = {
      frameId: "child-1",
      evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
        if (typeof expr === "string" && expr.includes("readyState")) return "complete";
        if (typeof expr === "string" && expr.includes("document.body")) return true;
        const url = frameUrlSequence[Math.min(frameUrlIndex, frameUrlSequence.length - 1)]!;
        frameUrlIndex += 1;
        return url;
      }),
    };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      // The top-level page never navigates — the wizard lives inside the iframe.
      url: (): string => "https://careers.example.org/apply",
      title: vi.fn().mockResolvedValue("Apply"),
      evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
        if (typeof expr === "string" && expr.includes("document.body")) return 10_000;
        if (typeof expr === "string" && expr.includes("querySelector")) {
          return { matched: true, src: IFRAME_SRC };
        }
        return null;
      }),
      frames: vi.fn().mockReturnValue([childFrame]),
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
      throw new StepVerificationError("step 0 failed verification", "cascade-exhausted");
    });

    process.argv = [
      "node",
      "recon-browser.ts",
      "--url",
      "https://careers.example.org/apply",
      "--flow",
      JSON.stringify({ steps: ["Fill in field 0"], frameSelector: "#apply_frame" }),
    ];

    await main();

    // The replan dispatcher's LLM path must never have been entered — the
    // frame-scoped short-circuit must fire even though the top page.url()
    // never changed.
    expect(guardedObserveStub).not.toHaveBeenCalled();
    expect(loggerStub.info).toHaveBeenCalledWith(
      expect.stringContaining("verification failed but the page already advanced past this step")
    );
  });
});
