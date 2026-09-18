/**
 * Acceptance coverage for `applyFailedStepFlagsToResumingBridgeStep`
 * (`src/scripts/recon-browser.ts`) across MULTIPLE consecutive, non-overlapping
 * replan cycles. The sibling tests
 * (`src/scripts/recon-browser.replan-captchagated-flag-retention.test.ts` and
 * `src/scraper/flow-runner.captcha-gated-flag-retained-on-replan-acceptance.test.ts`)
 * only cover ONE replan cycle whose bridge step happens to quote the same
 * control label as the step that just failed ("Continue" -> "Continue"). That
 * leaves the fallback path — which engages when the bridge step's own label
 * does NOT overlap the prior cycle's label — unpinned across repeated cycles.
 * This drives `main()` for real through THREE consecutive replan cycles,
 * each proposing a bridge step that quotes a DIFFERENT control label than the
 * prior cycle's bridge step (and than the original failed step), and asserts
 * every spliced bridge step still carries `captchaGated: true` /
 * `submitStep: true` deterministically on every cycle, not just the first.
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

const { guardedObserveStub } = vi.hoisted(() => ({ guardedObserveStub: vi.fn() }));
vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: guardedObserveStub,
  };
});

// The replan dispatcher drives the raw Anthropic SDK client (not the `ai`
// package) via buildAnthropicClient — stub the same seam the sibling
// acceptance tests use, so the LLM's raw output (deliberately missing
// captchaGated on every cycle) is what the splice path has to work with.
const { messagesParseStub } = vi.hoisted(() => ({ messagesParseStub: vi.fn() }));
vi.mock("@/lib/llm/anthropic-client", () => ({
  buildAnthropicClient: () => ({ messages: { parse: messagesParseStub } }),
  buildRephraseModel: () => null,
}));

import { StepVerificationError } from "@/scraper/errors";
import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";

const BASE_URL = "https://portal.example.net/app/checkout";
const ORIGINAL_STEP = "Click the 'Submit' button";
// Each bridge step quotes a control label distinct from every prior cycle's
// label, so neither the label-overlap match nor a stale "same label" fallback
// can accidentally paper over the fallback-index-0 path this test pins.
const BRIDGE_STEP_1 = "Solve the challenge, then click the 'Verify' button to continue";
const BRIDGE_STEP_2 = "Now click the 'Confirm' button to proceed past the prompt";
const BRIDGE_STEP_3 = "Finally click the 'Finish' button to complete the flow";

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
    // Deliberately omits `captchaGated` on every cycle's bridge step — the
    // retention this test pins must NOT depend on the mocked LLM output
    // ever containing it, on any cycle.
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
    title: vi.fn().mockResolvedValue("Checkout"),
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

describe("recon-browser/main — captchaGated flag retention across 3 consecutive non-overlapping replan cycles", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-replan-captchagated-multi-"));
    process.env.RECON_RUN_ID = "20260917-000000-replancaptchagatedmulti";
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

  it("re-applies captchaGated:true/submitStep:true on every spliced bridge step across 3 consecutive replan cycles, even though each cycle's bridge quotes a different control label than the last", async () => {
    const { stagehand } = makeFakePage();
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    messagesParseStub
      .mockResolvedValueOnce(replanResponse(BRIDGE_STEP_1))
      .mockResolvedValueOnce(replanResponse(BRIDGE_STEP_2))
      .mockResolvedValueOnce(replanResponse(BRIDGE_STEP_3));

    executeStepWithHealingStub.mockImplementation(async (args: { step: string }) => {
      if (args.step === BRIDGE_STEP_3) return "completed";
      throw new StepVerificationError(
        "step failed verification: cascade exhausted",
        "cascade-exhausted"
      );
    });

    process.argv = flowArgv();

    await expect(main()).resolves.toBeUndefined();

    // Three replan cycles fired (original step's exhaustion, then bridge #1's,
    // then bridge #2's), and the loop resumed by re-executing each spliced
    // bridge in turn before bridge #3 finally completes.
    expect(messagesParseStub).toHaveBeenCalledTimes(3);
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(4);

    const bridgeCall = (step: string): { captchaGated: boolean; submitStep: boolean } | undefined =>
      executeStepWithHealingStub.mock.calls.find(
        ([args]) => (args as { step: string }).step === step
      )?.[0] as { captchaGated: boolean; submitStep: boolean } | undefined;

    // Cycle 1: bridge quotes "Verify", overlapping neither the original
    // "Submit" label nor any prior bridge — exercises the fallback-index-0
    // path on the very first splice.
    const cycle1 = bridgeCall(BRIDGE_STEP_1);
    expect(cycle1).toBeDefined();
    expect(cycle1?.captchaGated).toBe(true);
    expect(cycle1?.submitStep).toBe(true);

    // Cycle 2: bridge quotes "Confirm", overlapping neither "Verify" (the
    // immediately-preceding cycle's label) nor "Submit" — the exact
    // "dropped after replan #1" shape: label-match and fallback both would
    // fail without deterministic re-application on every cycle, not just
    // the first.
    const cycle2 = bridgeCall(BRIDGE_STEP_2);
    expect(cycle2).toBeDefined();
    expect(cycle2?.captchaGated).toBe(true);
    expect(cycle2?.submitStep).toBe(true);

    // Cycle 3: bridge quotes "Finish", overlapping none of the prior labels
    // either — pins retention holds across a THIRD consecutive cycle, not
    // just a second.
    const cycle3 = bridgeCall(BRIDGE_STEP_3);
    expect(cycle3).toBeDefined();
    expect(cycle3?.captchaGated).toBe(true);
    expect(cycle3?.submitStep).toBe(true);
  });
});
