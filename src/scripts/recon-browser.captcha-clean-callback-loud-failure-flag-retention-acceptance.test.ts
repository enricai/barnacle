/**
 * Closes the causal link the recon report draws between the silent-
 * fallthrough fix (a captchaGated step whose callback is cleanly discovered
 * but whose transition is never confirmed by either the navigation poll or
 * the network-capture scan on any attempt must fail loudly rather than fall
 * through to the generic cascade — pinned red by
 * `src/scraper/flow-runner.captcha-clean-callback-no-confirmation-loud-failure-acceptance.test.ts`)
 * and the replan-splice flag-retention fix
 * (`applyFailedStepFlagsToResumingBridgeStep`, `src/scripts/recon-browser.ts`):
 * once this exact failure shape throws loudly, the resulting global-replan
 * splice must still deterministically carry `captchaGated: true` onto the
 * resuming bridge step, exactly as it already does for other failure kinds
 * (see the sibling
 * `src/scraper/flow-runner.captcha-gated-flag-retained-on-replan-acceptance.test.ts`).
 *
 * This test drives `main()` for real (only `createBrowserSession` and the
 * replan LLM call are stubbed, plus `executeStepWithHealing` itself, since
 * the point here is the splice site's unconditional flag re-application —
 * not flow-runner's internal captchaGated cascade logic, which the sibling
 * test above already exercises for real). The stub throws the same
 * diagnostic shape test-001 pins (a `StepVerificationError` with kind
 * `"cascade-exhausted"`, the kind flow-runner already uses for cascade
 * exhaustion), and the mocked replan LLM response deliberately omits
 * `captchaGated` from its proposed bridge step — retention must not depend
 * on the LLM's output containing it.
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
// package) via buildAnthropicClient — stub the same seam the acceptance
// tests for the replan budget/verdict paths use, so the LLM's raw output
// (deliberately missing captchaGated) is what the splice path has to work
// with.
const { messagesParseStub } = vi.hoisted(() => ({ messagesParseStub: vi.fn() }));
vi.mock("@/lib/llm/anthropic-client", () => ({
  buildAnthropicClient: () => ({ messages: { parse: messagesParseStub } }),
  buildRephraseModel: () => null,
}));

import { StepVerificationError } from "@/scraper/errors";
import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";

const BASE_URL = "https://portal.example.org/app/verification";
const ORIGINAL_STEP = "Solve the challenge and submit the form";
const BRIDGE_STEP = "Solve the challenge again, then submit the form once more";

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

function makeFakePage(): { page: Page; stagehand: Stagehand } {
  const session = { on: (): void => {}, off: (): void => {} };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: (): string => BASE_URL,
    title: vi.fn().mockResolvedValue("Verification"),
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

describe("recon-browser — clean-callback captchaGated loud failure retains its flag across a global replan splice", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-captcha-clean-callback-loud-"));
    process.env.RECON_RUN_ID = "20260918-000000-cleancallbackloud";
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

  it("re-applies captchaGated:true to the spliced bridge step after the clean-callback-no-confirmation loud failure, even though the mocked replan LLM output carried no flag at all", async () => {
    const { stagehand } = makeFakePage();
    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    messagesParseStub.mockResolvedValueOnce(replanResponse(BRIDGE_STEP));

    executeStepWithHealingStub.mockImplementation(async (args: { step: string }) => {
      if (args.step === ORIGINAL_STEP) {
        // Mirrors the diagnostic test-001 pins: a captchaGated step whose
        // callback is cleanly discovered on every attempt but whose
        // transition is never confirmed by either the navigation poll or
        // the network-capture scan, failing loudly instead of silently
        // falling through to the generic cascade.
        throw new StepVerificationError(
          "step failed verification: captchaGated step: callbackDiscovered=true registryState=populated " +
            "with no confirmed transition after exhausting all attempts",
          "cascade-exhausted"
        );
      }
      return "completed";
    });

    process.argv = flowArgv();

    await expect(main()).resolves.toBeUndefined();

    // The replan LLM was invoked exactly once (the original step's loud
    // captchaGated failure), and the loop resumed by re-executing the
    // spliced bridge step.
    expect(messagesParseStub).toHaveBeenCalledTimes(1);
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);

    const bridgeCallArgs = executeStepWithHealingStub.mock.calls.find(
      ([args]) => (args as { step: string }).step === BRIDGE_STEP
    )?.[0] as { step: string; captchaGated: boolean; submitStep: boolean } | undefined;

    expect(bridgeCallArgs).toBeDefined();
    // Deterministic re-application, not LLM inference: the mocked replan
    // response never set captchaGated on this step, yet the spliced step
    // that re-executes against the same control action still carries it —
    // the splice site applies this unconditionally, regardless of which
    // failure kind produced the replan.
    expect(bridgeCallArgs?.captchaGated).toBe(true);
    expect(bridgeCallArgs?.submitStep).toBe(true);
  });
});
