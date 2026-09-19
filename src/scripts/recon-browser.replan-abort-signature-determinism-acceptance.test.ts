/**
 * Acceptance test proving that `main()`'s REAL abort-selection branch
 * (recon-browser.ts, the cascade-budget check immediately followed by
 * `isReplanCycle` in the step-loop's catch block) is deterministic for two
 * independently driven runs that hit a structurally identical stuck-step
 * shape: same failed step, same repeated cascade-exhausted failure on every
 * attempt, same paraphrase-varying replan proposals, same static page-state
 * progression (constant `bodyHtmlLength`, no URL change). The two runs
 * differ only in incidental bookkeeping that must not affect the outcome —
 * a different `RECON_RUN_ID`/session id per run and a fresh module graph
 * (`resolveReconRunDir` memoizes its run dir per module instance —
 * `recon-run-isolation.test.ts` establishes the same `vi.resetModules()` +
 * dynamic-import seam this test reuses to hold two independent runs) —
 * never in the shape of the stuck step itself.
 *
 * `src/scraper/flow-runner.replan-exhaustion-abort-signature-acceptance.test.ts`
 * and `src/scripts/recon-browser.replan-cycle-structural-parity.test.ts`
 * both pin `isReplanCycle` itself via a hand-rolled `selectAbortForStuckStep`
 * reproduction of main()'s branch — they can prove the predicate is
 * deterministic but can never catch a nondeterminism source living in
 * main()'s own cascade-budget bookkeeping (an off-by-one in how
 * `cascadeReplansUsed` is read against `resolvedCascadeBudget`, per the
 * ca76760/df29db7/844f73b commit history of budget-counter bugs in this
 * exact area). This test drives `main()` end-to-end twice — only
 * `@/scraper/session`'s `createBrowserSession`, `executeStepWithHealing`,
 * and the replan LLM call are stubbed — so both runs exercise the real
 * counter increments and the real budget comparison, not a reproduction of
 * it.
 *
 * Shape: the flow's single step always fails cascade-exhausted verification.
 * Two cascade replans are proposed and spent (bridge 1 → "Confirm Details",
 * bridge 2 → "Proceed To Payment" — deliberately distinct quoted labels from
 * the step each replaces so `isReplanReproposingFailedStep`'s immediate
 * no-progress short-circuit never fires, forcing the run through the real
 * `cascadeReplansUsed` increments). `maxCascadeReplans` is fixed at 2, so
 * the THIRD failure finds `usedSoFar (2) >= budget (2)` and aborts on
 * budget exhaustion before ever reaching the cycle check — a StepVerification-
 * Error carrying the original failure's kind ("cascade-exhausted").
 *
 * Falsifier this pins: a budget-counter regression that double-counts or
 * under-counts a replan (e.g. incrementing on the wrong branch, or losing a
 * count across the loop's `i--`/re-entry) would make one of the two runs
 * abort one replan earlier or later than the other, surfacing as a kind
 * mismatch between the two `StepVerificationError`s below even though both
 * runs were fed byte-for-byte identical stuck-step fixtures.
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
      maxCascadeReplans: 2,
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
const BRIDGE_1 = "Click the 'Confirm Details' button to acknowledge and continue";
const BRIDGE_2 = "Click the 'Proceed To Payment' button to move forward";

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
 * Drives one full `main()` invocation through the identical stuck-step
 * shape: the original step and both replan bridges always fail cascade
 * verification, and the replan LLM always proposes the same two bridge
 * instructions in the same order. `sessionSuffix` is the only thing that
 * varies between calls — it stands in for the incidental per-run
 * bookkeeping (session id, run id, module graph) that must not affect the
 * abort kind. `vi.resetModules()` before each run forces a fresh
 * `recon-shared` module instance (its run-dir resolver memoizes per module
 * instance), and the fresh `@/scraper/errors` module instance it pulls in is
 * returned alongside the thrown error so the caller's `instanceof` check
 * lines up with the class the *same* run's `main()` actually threw.
 */
async function runIdenticalStuckShapeOnce(sessionSuffix: string): Promise<{
  error: StepVerificationErrorType;
  StepVerificationError: typeof StepVerificationErrorType;
  execCallCount: number;
  replanCallCount: number;
}> {
  const runsRoot = mkdtempSync(join(tmpdir(), `recon-browser-abort-determinism-${sessionSuffix}-`));
  process.env.RECON_RUN_ID = `20260917-000000-abortdeterminism${sessionSuffix}`;
  process.env.RECON_OUT_DIR = runsRoot;
  // Module-bottom `main().catch(...)` self-invokes on import whenever
  // `process.argv[1]` looks like `recon-browser.ts`/`.js` — reset argv to a
  // harmless value before the fresh import so a prior run's still-lingering
  // `flowArgv()` (set below, after import, for THIS run) can't trigger that
  // self-invocation against a not-yet-configured module instance.
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
    messagesParseStub
      .mockResolvedValueOnce(replanResponse(BRIDGE_1))
      .mockResolvedValueOnce(replanResponse(BRIDGE_2));

    executeStepWithHealingStub.mockReset();
    // Every attempt fails cascade-exhausted verification — the stuck-step
    // shape never resolves, regardless of which of the three step texts
    // (original, bridge 1, bridge 2) is currently being attempted.
    executeStepWithHealingStub.mockImplementation(async () => {
      throw new StepVerificationError(
        "step failed verification after all heal attempts",
        "cascade-exhausted"
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
      execCallCount: executeStepWithHealingStub.mock.calls.length,
      replanCallCount: messagesParseStub.mock.calls.length,
    };
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
}

describe("recon-browser/main deterministic terminal-abort signature for an identically-shaped stuck step", () => {
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

  it("two independent main() runs against the identical stuck-step shape both abort via the same StepVerificationError.kind", async () => {
    const runA = await runIdenticalStuckShapeOnce("a");
    const runB = await runIdenticalStuckShapeOnce("b");

    // Both runs exhaust the 2-replan cascade budget on the third identical
    // failure and abort with the original failure's kind, never diverging
    // into "replan-cycle-detected" — the bridges' distinct quoted labels
    // ("Confirm Details" / "Proceed To Payment") keep both runs off the
    // isReplanReproposingFailedStep short-circuit and off isReplanCycle's
    // 3-repeat threshold, forcing both through the real cascadeReplansUsed
    // increments instead.
    expect(runA.error.kind).toBe("cascade-exhausted");
    expect(runB.error.kind).toBe("cascade-exhausted");
    expect(runA.error.kind).toBe(runB.error.kind);

    // Same total replan-dispatch shape on both runs: 2 LLM replan calls, 3
    // step-execution attempts (original + 2 bridges), each throwing
    // identically.
    expect(runA.execCallCount).toBe(3);
    expect(runB.execCallCount).toBe(3);
    expect(runA.replanCallCount).toBe(2);
    expect(runB.replanCallCount).toBe(2);
  });
});
