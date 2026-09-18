/**
 * Acceptance coverage for `applyFailedStepFlagsToResumingBridgeStep`
 * (`src/scripts/recon-browser.ts`) for the specific failure texture produced
 * by the disabled-candidate exhaustion root cause: a `captchaGated` step
 * that exhausts all solve+inject attempts against a disabled candidate,
 * falls through to the phantom-click cascade, and terminally fails with
 * `StepVerificationError` kind `"phantom-click-exhausted"` (not the generic
 * `"cascade-exhausted"` kind the sibling multi-cycle fixture uses). The
 * replan LLM's proposed bridge step names the challenge widget itself
 * rather than the original control, sharing no quoted label with the failed
 * step. This drives `main()` end-to-end and asserts the spliced bridge step
 * still carries `captchaGated: true` / `submitStep: true`, proving flag
 * retention is invariant to this failure shape too, not just the generic
 * cascade-exhausted fixtures.
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
// captchaGated) is what the splice path has to work with.
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
// The replan bridge step names the challenge widget itself, not the
// original control — sharing no quoted label with the failed step, mirroring
// the disabled-candidate exhaustion report's specific wording pattern.
const BRIDGE_STEP = "Solve the verification widget shown in the overlay, then continue";

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
    // Deliberately omits `captchaGated` — the retention this test pins must
    // NOT depend on the mocked LLM output ever containing it.
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

describe("recon-browser/main — captchaGated flag retention for phantom-click-exhausted disabled-candidate shape", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-replan-captchagated-disabled-candidate-"));
    process.env.RECON_RUN_ID = "20260917-000001-replancaptchagateddisabledcandidate";
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

  it("re-applies captchaGated:true/submitStep:true on the spliced bridge step when the failed step terminally fails with kind 'phantom-click-exhausted'", async () => {
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
      if (args.step === BRIDGE_STEP) return "completed";
      // Models the disabled-candidate exhaustion: all solve+inject attempts
      // fall through to the phantom-click cascade and terminally fail with
      // kind "phantom-click-exhausted", not the generic "cascade-exhausted".
      throw new StepVerificationError(
        "step failed verification: phantom-click cascade exhausted",
        "phantom-click-exhausted"
      );
    });

    process.argv = flowArgv();

    await expect(main()).resolves.toBeUndefined();

    expect(messagesParseStub).toHaveBeenCalledTimes(1);
    expect(executeStepWithHealingStub).toHaveBeenCalledTimes(2);

    const bridgeCall = executeStepWithHealingStub.mock.calls.find(
      ([args]) => (args as { step: string }).step === BRIDGE_STEP
    )?.[0] as { captchaGated: boolean; submitStep: boolean } | undefined;

    expect(bridgeCall).toBeDefined();
    expect(bridgeCall?.captchaGated).toBe(true);
    expect(bridgeCall?.submitStep).toBe(true);
  });
});
