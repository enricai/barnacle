/**
 * Combined acceptance test proving the report's actual production shape: a
 * same-page toggle step whose verdict swings between phantom and effective
 * across attempts, spanning a session that dies mid-cascade (discovered via
 * `session.getCdpTransportClosedError?.()`, recon-browser.ts:2987-2991) and
 * is retried on a fresh session. Neither dimension alone proves this — the
 * alternating-verdict fixture in flow-runner.evidence-table-alternating-
 * verdict-regression.test.ts never touches a session retry, and the CDP-
 * transport-retry fixture in recon-browser.cascade-budget-persists-across-
 * session-retry-regression.test.ts drives a scripted always-fail/always-pass
 * step set, never an alternating verdict. This test drives `main()` for real
 * (only `@/scraper/session`'s `createBrowserSession` and the replan LLM call
 * are stubbed) and feeds each `executeStepWithHealing` outcome through the
 * REAL, unmocked `classifyPhantomClick` (phantom-click.ts) against
 * pre/post-click snapshots shaped like the bug report's own evidence table,
 * so the phantom/effective verdict on every attempt is genuinely computed,
 * not asserted by fiat.
 *
 * Session 1: the original step's click leaves the DOM and selection state
 * completely unchanged — a genuine `classifyPhantomClick` "phantom" verdict
 * — consuming 1/5 of the cascade-replan budget before a bridge step (an
 * element-scoped selection-state flip, mirroring the report's `6wlcrv:4`
 * fingerprint swap) resolves as genuinely "effective" and completes the
 * session. Only then does the post-loop check discover session 1's CDP
 * transport was torn down, forcing a whole-session retry (bugfix-001's
 * fix — recon-browser.ts:2325-2330 — is what lets the SAME `cascadeReplansUsed`
 * closure survive that retry instead of resetting to 0).
 *
 * Session 2 re-parses the same original flow (main() rebuilds `plan` from
 * the outer `flow` array on every attempt — recon-browser.ts:2419) and hits
 * the identical step again: it alternates BACK to phantom (2/5), then a
 * submit-shaped bridge step's DOM-only growth is correctly vetoed back to
 * phantom too (3/5) — the exact byte-delta submit veto bugfix-002
 * (deea744) added to `classifyPhantomClick` (phantom-click.ts:90-91). Only a
 * final bridge whose click actually changes the URL (a real, non-submit-
 * byte-reflow effect) resolves the run.
 *
 * Falsifiers this pins:
 *  - Pre-df29db7 (`cascadeReplansUsed` reset on session retry): session 2's
 *    replans would log "cascade budget 1/5" and "2/5" instead of the
 *    carried-over "2/5" and "3/5" this test asserts verbatim.
 *  - Pre-deea744 (`classifyPhantomClick` byte-delta signal not vetoed for
 *    submit-shaped steps): the submit-shaped bridge's DOM-only growth would
 *    misclassify as "effective", resolving the run after only 2 replans
 *    instead of 3 — `messagesParseStub` would be called 2 times, not 3.
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
      maxProbeReplans: 5,
      maxTransportRetries: 2,
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

// The step-execution outcome ("phantom" throw vs. "effective" resolve) is
// computed inside the stub by calling the REAL classifyPhantomClick, so only
// the network/DOM plumbing around it is stubbed, not the verdict itself.
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
import { StepVerificationError } from "@/scraper/errors";
import { classifyPhantomClick, type PhantomClickAttempt } from "@/scraper/phantom-click";
import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";

const BASE_URL = "https://portal.example.net/app/preferences";
const ORIGINAL_STEP = "Click the 'Notify' toggle to enable it";
const BRIDGE_SELECTION_FLIP = "Click the 'Confirm Notify' toggle to finish";
const BRIDGE_SUBMIT_DOM_GROWTH = "Click the 'Submit' button to finish application";
const BRIDGE_URL_CHANGE = "Click the 'Confirmation' link to complete";

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
    title: vi.fn().mockResolvedValue("Preferences"),
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
 * Feeds a bug-report-shaped pre/post pair through the REAL classifyPhantomClick
 * and throws/resolves exactly as the production cascade would for that verdict.
 */
function resolveViaRealVerdict(step: string, attempt: PhantomClickAttempt): "completed" {
  const verdict = classifyPhantomClick(attempt);
  if (verdict === "effective") return "completed";
  throw new StepVerificationError(
    `step failed verification: ${step}`,
    verdict === "phantom" ? "phantom-click-exhausted" : "cascade-exhausted"
  );
}

describe("recon-browser/main — alternating phantom/effective verdict resolves across a mid-cascade CDP-transport session retry with a carried-over cascade budget", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-combined-verdict-budget-"));
    process.env.RECON_RUN_ID = "20260917-000000-combinedverdictbudget";
    process.env.RECON_OUT_DIR = runsRoot;
    executeStepWithHealingStub.mockReset();
    guardedObserveStub.mockReset();
    guardedObserveStub.mockResolvedValue([]);
    messagesParseStub.mockReset();
    generateObjectStub.mockReset();
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
    executeStepWithHealingStub.mockReset();
    guardedObserveStub.mockReset();
    messagesParseStub.mockReset();
  });

  it("carries the cascade budget across the CDP-retry session while the same step's verdict alternates between phantom and effective", async () => {
    const { stagehand: session1Stagehand } = makeFakePage();
    const { stagehand: session2Stagehand } = makeFakePage();
    const cdpTransportClosedError = {
      message: "scraper session's CDP transport was closed by the SDK: teardown initiated",
    };

    vi.mocked(createBrowserSession)
      .mockResolvedValueOnce({
        stagehand: session1Stagehand,
        limiter: {} as never,
        sessionId: "test-session-1",
        provider: "browserbase",
        close: vi.fn().mockResolvedValue(undefined),
        getCdpTransportClosedError: () => cdpTransportClosedError,
      } as never)
      .mockResolvedValueOnce({
        stagehand: session2Stagehand,
        limiter: {} as never,
        sessionId: "test-session-2",
        provider: "browserbase",
        close: vi.fn().mockResolvedValue(undefined),
        getCdpTransportClosedError: () => undefined,
      } as never);

    messagesParseStub
      .mockResolvedValueOnce(replanResponse(BRIDGE_SELECTION_FLIP))
      .mockResolvedValueOnce(replanResponse(BRIDGE_SUBMIT_DOM_GROWTH))
      .mockResolvedValueOnce(replanResponse(BRIDGE_URL_CHANGE));

    executeStepWithHealingStub.mockImplementation(async (args: { step: string }) => {
      const baseSnapshot = { networkCount: 0, url: BASE_URL, bodyHtmlLength: 10_000 };
      switch (args.step) {
        // Session 1, attempt 1 on the original step and session 2, attempt 1
        // on the SAME re-parsed original step (recon-browser.ts:2419 rebuilds
        // `plan` from `flow` fresh on every retry) — the click genuinely
        // leaves the DOM and selection state completely unchanged both
        // times: a real "phantom" verdict, not a scripted failure.
        case ORIGINAL_STEP:
          return resolveViaRealVerdict(args.step, {
            actResultSuccess: true,
            pre: baseSnapshot,
            post: baseSnapshot,
            elementStateChanged: false,
            isSubmitShapedStep: false,
          });
        // Session 1's bridge: no network/URL/byte signal at all, but the
        // clicked element's OWN committed selection state flips — mirrors the
        // report's `6wlcrv:4` element-scoped fingerprint swap — a genuine
        // "effective" verdict via elementStateChanged alone.
        case BRIDGE_SELECTION_FLIP:
          return resolveViaRealVerdict(args.step, {
            actResultSuccess: true,
            pre: baseSnapshot,
            post: baseSnapshot,
            elementStateChanged: true,
            isSubmitShapedStep: false,
          });
        // Session 2's second bridge: submit-shaped, and its only signal is a
        // +700B DOM-only growth (no network, no URL change) — bugfix-002
        // (deea744) vetoes the byte-delta signal for submit-shaped steps, so
        // this is genuinely "phantom" post-fix (a pre-fix run would wrongly
        // classify it "effective" here and never reach the 3rd replan below).
        case BRIDGE_SUBMIT_DOM_GROWTH:
          return resolveViaRealVerdict(args.step, {
            actResultSuccess: true,
            pre: baseSnapshot,
            post: { ...baseSnapshot, bodyHtmlLength: baseSnapshot.bodyHtmlLength + 700 },
            elementStateChanged: false,
            isSubmitShapedStep: true,
          });
        // Session 2's final bridge: a real URL change — unambiguously
        // "effective" regardless of the submit-shape veto, resolving the run.
        case BRIDGE_URL_CHANGE:
          return resolveViaRealVerdict(args.step, {
            actResultSuccess: true,
            pre: baseSnapshot,
            post: { ...baseSnapshot, url: `${BASE_URL}?confirmed=1` },
            elementStateChanged: false,
            isSubmitShapedStep: false,
          });
        default:
          throw new Error(`unexpected step in test stub: ${args.step}`);
      }
    });

    process.argv = flowArgv();

    await expect(main()).resolves.toBeUndefined();

    // Exactly two sessions for the whole run: one for the CDP-transport
    // teardown, one for the successful retry.
    expect(createBrowserSession).toHaveBeenCalledTimes(2);

    // 3 replans total across both sessions: 1 on session 1 (the original
    // step's phantom verdict), 2 on session 2 (the re-parsed original step's
    // phantom verdict again, then the submit-shaped bridge's vetoed byte
    // growth) — proves classifyPhantomClick's real production behavior, not
    // a scripted pass/fail sequence.
    expect(messagesParseStub).toHaveBeenCalledTimes(3);
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(5);

    // The budget log lines carry the count FORWARD across the session
    // retry — bugfix-001's fix. A reverted fix would log "1/5" and "2/5"
    // here instead of the carried-over "2/5" and "3/5".
    const warnLines = loggerStub.warn.mock.calls.map((c) => String(c[0]));
    // Each budget count logs exactly once across the whole run — a reset on
    // the session-retry would re-log "cascade budget 1/5" a second time
    // instead of continuing on to "2/5" and "3/5".
    expect(warnLines.filter((line) => line.includes("cascade budget 1/5"))).toHaveLength(1);
    expect(warnLines.filter((line) => line.includes("cascade budget 2/5"))).toHaveLength(1);
    expect(warnLines.filter((line) => line.includes("cascade budget 3/5"))).toHaveLength(1);

    const allLogged = [
      ...loggerStub.info.mock.calls.map((c) => String(c[0])),
      ...loggerStub.warn.mock.calls.map((c) => String(c[0])),
      ...loggerStub.error.mock.calls.map((c) => String(c[0])),
    ].join("\n");
    expect(allLogged).not.toContain("replan budget exhausted");
    expect(allLogged).not.toContain("terminally failed (cascade-exhausted)");
  });
});
