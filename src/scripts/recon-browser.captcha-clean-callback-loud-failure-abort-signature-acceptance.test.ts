/**
 * Acceptance test pinning the causal link to Signature C from the recon
 * report: when the SAME unconfirmed-clean-callback captchaGated failure
 * (test-001's exact diagnostic shape) recurs across replans under a
 * genuinely static page state, `main()` must consistently hit the
 * cycle-detector terminal abort (recon-browser.ts:3001,
 * `isReplanCycle`/`REPLAN_CYCLE_THRESHOLD`) rather than alternating between
 * that and the generic "replan budget exhausted" abort for a structurally
 * identical stuck state — the exact alternation the recon report observed
 * (one run hit "replan cycle detected", two sibling runs on the same stuck
 * shape hit "phantom-click-exhausted replan budget exhausted" instead).
 *
 * Shape: the flow's single step always terminally fails with the kind a
 * captchaGated step's clean-callback/zero-confirmed-transition failure
 * surfaces once it stops falling through silently ("phantom-click-exhausted"
 * — the same kind flow-runner.ts:12235 assigns when every cascade attempt
 * produces no observable effect, which is exactly what an unconfirmed
 * captcha transition looks like from the step-verification boundary). The
 * replan LLM proposes a paraphrase-varying bridge at every one of
 * REPLAN_CYCLE_THRESHOLD (3) replans, always targeting the same quoted
 * control and always phrased as a compound clause (so
 * `isReplanReproposingFailedStep`'s immediate no-progress short-circuit,
 * which matches on quoted-label signature alone, never fires ahead of the
 * cycle check) — under a page snapshot (`url`/`bodyHtmlLength`) that never
 * changes. `maxCascadeReplans` is set to 5, well above the 3 replans this
 * takes to trip `isReplanCycle`, so a regression that makes the run fall
 * through to budget exhaustion (rather than recognizing the cycle) is
 * distinguishable from one that correctly detects it — both message
 * variants are structurally reachable here, only the correct one should
 * fire.
 *
 * Falsifier this pins: driving the same stuck shape twice (fresh module
 * graph, fresh run id each time, like
 * recon-browser.replan-abort-signature-determinism-acceptance.test.ts)
 * must produce the identical abort signature both times. A regression that
 * makes `isReplanCycle`'s quoted-label signature comparison flaky against
 * this specific failure kind (e.g. an ordering-sensitive replanEvents scan)
 * would surface as one run aborting "replan cycle detected" and the other
 * "phantom-click-exhausted replan budget exhausted" despite byte-for-byte
 * identical fixtures — the exact alternation this test exists to rule out.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      maxProbeReplans: 2,
      maxTransportRetries: 2,
    },
    telemetry: {
      callsNdjsonPath: ".barnacle/calls.ndjson",
    },
  },
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));

// `waitForSpaReady` gates readiness with `withWatchdog`, which races the
// fake page's mocked `evaluate()` against a REAL `setTimeout`. The mocked
// promise settles synchronously in test terms, but under scheduler
// contention its microtask can be starved past the watchdog's real timer,
// spuriously "timing out" and driving the function into its real
// `page.waitForTimeout`-polling loop against a real `Date.now()` deadline —
// a genuine wall-clock dependency this test must not inherit, since it is
// orthogonal to the cascade-budget/replan-cycle abort signature under test.
vi.mock("@/scraper/spa-readiness", () => ({
  waitForSpaReady: vi.fn().mockResolvedValue(undefined),
}));

const { createBrowserSessionStub } = vi.hoisted(() => ({
  createBrowserSessionStub: vi.fn(),
}));
vi.mock("@/scraper/session", () => ({ createBrowserSession: createBrowserSessionStub }));

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

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { StepVerificationError as StepVerificationErrorType } from "@/scraper/errors";

const BASE_URL = "https://portal.example.net/app/apply";
const ORIGINAL_STEP = "Click the 'Submit Application' button";
// All bridges keep a compound clause (a comma outside the quoted span) so
// isReplanReproposingFailedStep's quoted-label-only comparison never
// short-circuits ahead of the cycle check, and all quote the SAME control
// label so isReplanCycle's structural signature recognizes them as one
// repeated proposal despite the surrounding prose varying every time.
const BRIDGE_WORDINGS = [
  "Click the 'Submit Application' button, then wait for the confirmation banner",
  "Press the 'Submit Application' button, then check for a success toast",
  "Tap the 'Submit Application' control, then look for the receipt id",
  "Hit the 'Submit Application' button one more time, then check the outcome",
];

function flowArgv(): string[] {
  return ["node", "recon-browser.ts", "--url", BASE_URL, "--flow", JSON.stringify([ORIGINAL_STEP])];
}

function replanResponse(bridgeStep: string): {
  parsed_output: { outcome: string; steps: string[] };
  content: { type: string; text: string }[];
  usage: { input_tokens: number; output_tokens: number };
} {
  return {
    parsed_output: { outcome: "replan", steps: [bridgeStep] },
    content: [{ type: "text", text: "" }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function makeFakePage(): { page: Page; stagehand: Stagehand } {
  const session = { on: (): void => {}, off: (): void => {} };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    // Never changes across any replan — the "genuinely static page state"
    // this subtask keys the cycle detector to.
    url: (): string => BASE_URL,
    title: vi.fn().mockResolvedValue("Apply"),
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

/**
 * Drives one full `main()` invocation through the captchaGated loud-failure
 * shape from test-001, repeated across REPLAN_CYCLE_THRESHOLD replans under
 * an unchanging page snapshot. `sessionSuffix` is the only thing that varies
 * between calls — incidental per-run bookkeeping that must not affect the
 * abort kind, per the same `vi.resetModules()` seam
 * recon-browser.replan-abort-signature-determinism-acceptance.test.ts uses.
 */
async function runIdenticalCaptchaGatedStuckShapeOnce(sessionSuffix: string): Promise<{
  error: StepVerificationErrorType;
  StepVerificationError: typeof StepVerificationErrorType;
  errorLines: string[];
}> {
  const runsRoot = mkdtempSync(
    join(tmpdir(), `recon-browser-captcha-loud-failure-abort-${sessionSuffix}-`)
  );
  process.env.RECON_RUN_ID = `20260918-000000-captchaloudfailure${sessionSuffix}`;
  process.env.RECON_OUT_DIR = runsRoot;
  process.argv = ["node", "vitest"];
  vi.resetModules();

  try {
    const { StepVerificationError } = await import("@/scraper/errors.js");
    const { main } = await import("@/scripts/recon-browser.js");

    const { stagehand } = makeFakePage();

    createBrowserSessionStub.mockReset();
    createBrowserSessionStub.mockResolvedValueOnce({
      stagehand,
      limiter: {} as never,
      sessionId: `test-session-${sessionSuffix}`,
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
      getCdpTransportClosedError: () => undefined,
    } as never);

    messagesParseStub.mockReset();
    for (const wording of BRIDGE_WORDINGS) {
      messagesParseStub.mockResolvedValueOnce(replanResponse(wording));
    }

    executeStepWithHealingStub.mockReset();
    // Every attempt (original step, and every bridge) reproduces the exact
    // captchaGated loud-failure diagnostic from test-001: the clean callback
    // fires but no navigation/network transition ever confirms the advance,
    // which surfaces at the step-verification boundary as
    // "phantom-click-exhausted" — the same kind flow-runner.ts assigns any
    // time every cascade attempt produces no observable effect.
    executeStepWithHealingStub.mockImplementation(async () => {
      throw new StepVerificationError(
        "step failed verification after all heal attempts",
        "phantom-click-exhausted"
      );
    });

    guardedObserveStub.mockReset();
    guardedObserveStub.mockResolvedValue([]);
    generateObjectStub.mockReset();
    loggerStub.info.mockClear();
    loggerStub.warn.mockClear();
    loggerStub.error.mockClear();

    process.argv = flowArgv();

    let thrown: unknown;
    try {
      await main();
    } catch (err) {
      thrown = err;
    }
    if (!(thrown instanceof StepVerificationError)) {
      throw new Error(`expected main() to throw StepVerificationError, got: ${String(thrown)}`);
    }
    return {
      error: thrown,
      StepVerificationError,
      errorLines: loggerStub.error.mock.calls.map((c) => String(c[0])),
    };
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
}

describe("recon-browser/main deterministic cycle-detector abort for a recurring captchaGated loud failure under a static page", () => {
  const ORIGINAL_ARGV = process.argv;

  beforeEach(() => {
    createBrowserSessionStub.mockReset();
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
    executeStepWithHealingStub.mockReset();
    guardedObserveStub.mockReset();
    messagesParseStub.mockReset();
  });

  it("two independent main() runs both abort via the cycle-detector's exact message, never the generic budget-exhausted message", async () => {
    const runA = await runIdenticalCaptchaGatedStuckShapeOnce("a");
    const runB = await runIdenticalCaptchaGatedStuckShapeOnce("b");

    for (const run of [runA, runB]) {
      expect(run.error.kind).toBe("replan-cycle-detected");
      expect(run.error.message).toBe(
        "replan cycle detected: identical proposal × 3 under static page state; aborting"
      );
      // The single logger.error call at the abort point carries the exact
      // cycle-detector message from recon-browser.ts:3008 — never the
      // alternate "<kind> replan budget exhausted" signature the recon
      // report observed on sibling runs of this same stuck shape.
      expect(run.errorLines).toContain(
        "replan cycle detected: identical proposal × 3 under static page state; aborting"
      );
      expect(run.errorLines.some((l) => l.includes("replan budget exhausted"))).toBe(false);
    }

    expect(runA.error.kind).toBe(runB.error.kind);
    expect(runA.error.message).toBe(runB.error.message);
  });
});
