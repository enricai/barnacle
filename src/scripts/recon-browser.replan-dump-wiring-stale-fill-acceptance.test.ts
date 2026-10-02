/**
 * Every existing test for the stale-fill replan decision calls
 * `filterCompletedFromReplan` directly with hand-built `bodyHtmlAtFailure`/
 * `fieldValuesAtFailure` arguments. None of them exercise the actual wiring
 * in `recon-browser.ts`'s `main()` replan loop that reads a failure dump's
 * JSON off disk and threads `bodyOuterHtml`/`fieldValuesAtFailure` into the
 * filter — the call site the original report's bug lived in. This file
 * drives that wiring end to end through `main()` the same way
 * `recon-browser.replan-submit-judge-diagnostic-field-bridge-acceptance.test.ts`
 * does (only `createBrowserSession`, `executeStepWithHealing`, and the
 * replan Anthropic client are stubbed): a real on-disk dump file is written
 * with `writeFileSync` so the unmocked `readFileSync`/`JSON.parse` at the
 * call site actually runs, across two sequential terminal-failure/replan
 * cycles, proving a reset confirmation-style field keeps getting
 * re-dispatched rather than silently dropped as "already completed".
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { createBrowserSessionStub } = vi.hoisted(() => ({
  createBrowserSessionStub: vi.fn(),
}));
vi.mock("@/scraper/session", () => ({ createBrowserSession: createBrowserSessionStub }));
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

const { messagesParseStub } = vi.hoisted(() => ({ messagesParseStub: vi.fn() }));
vi.mock("@/lib/llm/anthropic-client", () => ({
  buildAnthropicClient: () => ({ messages: { parse: messagesParseStub } }),
  buildRephraseModel: () => null,
}));

import { StepVerificationError } from "@/scraper/errors";
import { main } from "@/scripts/recon-browser";

const BASE_URL = "https://signup.example.net/app/newsletter";
const EMAIL_VALUE = "reader@example.com";
const PASSWORD_VALUE = "Sprout-42!";

const FILL_EMAIL = `Fill in the Email field with '${EMAIL_VALUE}'`;
const FILL_PASSWORD = `Fill in the Password field with '${PASSWORD_VALUE}'`;
const FILL_CONFIRM_PASSWORD = `Fill in the Confirm Password field with '${PASSWORD_VALUE}'`;
const CLICK_CREATE_ACCOUNT = "Click the 'Create Account' button";

function flowArgv(): string[] {
  return [
    "node",
    "recon-browser.ts",
    "--url",
    BASE_URL,
    "--flow",
    JSON.stringify([
      { step: FILL_EMAIL },
      { step: FILL_PASSWORD },
      { step: FILL_CONFIRM_PASSWORD },
      { step: CLICK_CREATE_ACCOUNT },
    ]),
  ];
}

/**
 * Same branching as the sibling acceptance test: the invalid-field/error-
 * message judge calls must resolve to empty verdicts so they don't consume
 * the replan-outcome mock slot.
 */
function makeReplanClient(replanSteps: string[]): void {
  messagesParseStub.mockImplementation(async ({ system }: { system?: string }) => {
    const parsed_output = system?.includes("invalid-field detector")
      ? { fields: [] }
      : system?.includes("error-message extractor")
        ? { messages: [] }
        : { outcome: "replan", steps: replanSteps };
    return {
      parsed_output,
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 100, output_tokens: 5 },
    };
  });
}

function makeFakePage(): { page: Page; stagehand: Stagehand } {
  const session = { on: (): void => {}, off: (): void => {} };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: (): string => BASE_URL,
    title: vi.fn().mockResolvedValue("Newsletter signup"),
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

describe("recon-browser/main — on-disk failure dump wiring keeps a reset confirmation field re-dispatched across replan cycles", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;
  let tmpDumpDir: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-dump-wiring-"));
    tmpDumpDir = mkdtempSync(join(tmpdir(), "recon-browser-dump-wiring-dump-"));
    process.env.RECON_RUN_ID = "20261002-000000-dumpwiring";
    process.env.RECON_OUT_DIR = runsRoot;
    executeStepWithHealingStub.mockReset();
    guardedObserveStub.mockReset();
    guardedObserveStub.mockResolvedValue([]);
    messagesParseStub.mockReset();
    generateObjectStub.mockReset();
    createBrowserSessionStub.mockReset();
    loggerStub.info.mockClear();
    loggerStub.warn.mockClear();
    loggerStub.error.mockClear();
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    rmSync(tmpDumpDir, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
    executeStepWithHealingStub.mockReset();
    guardedObserveStub.mockReset();
    messagesParseStub.mockReset();
  });

  it("re-dispatches the Confirm Password fill on every replan cycle whose on-disk dump shows it reset, while Email/Password stay dropped as genuinely completed", async () => {
    const dumpPathCycle1 = join(tmpDumpDir, "step-failure-1.json");
    const dumpPathCycle2 = join(tmpDumpDir, "step-failure-2.json");

    // Both on-disk dumps show the exact shape `readFailureDumpEvidence`/
    // `executeStepWithHealing` produce: Email and Password retain their
    // values, Confirm Password reads back empty — a silent client-side
    // reset the completed-steps bookkeeping never saw.
    const dumpBody = {
      bodyOuterHtml: null,
      fieldValuesAtFailure: [
        { label: "Email", value: EMAIL_VALUE },
        { label: "Password", value: PASSWORD_VALUE },
        { label: "Confirm Password", value: "" },
      ],
      attempts: [{ errorMessage: "selector not found: button[type=submit]" }],
    };
    writeFileSync(dumpPathCycle1, JSON.stringify(dumpBody));
    writeFileSync(dumpPathCycle2, JSON.stringify(dumpBody));

    makeReplanClient([FILL_EMAIL, FILL_PASSWORD, FILL_CONFIRM_PASSWORD, CLICK_CREATE_ACCOUNT]);

    const { stagehand } = makeFakePage();
    createBrowserSessionStub.mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    let createAccountAttempts = 0;
    executeStepWithHealingStub.mockImplementation(async (args: { step: string }) => {
      if (args.step === CLICK_CREATE_ACCOUNT) {
        createAccountAttempts++;
        // Fails on cycle 1 and cycle 2, succeeds on the third (post-cycle-2) attempt.
        if (createAccountAttempts < 3) {
          const dumpPath = createAccountAttempts === 1 ? dumpPathCycle1 : dumpPathCycle2;
          throw new StepVerificationError(
            `step failed verification: cascade exhausted; see ${dumpPath}`,
            "cascade-exhausted"
          );
        }
        return "completed";
      }
      return "completed";
    });

    process.argv = flowArgv();

    await expect(main()).resolves.toBeUndefined();

    const executedSteps = executeStepWithHealingStub.mock.calls.map(
      ([args]) => (args as { step: string }).step
    );

    // Confirm Password was re-dispatched on the initial fill plus once per
    // replan cycle (two cycles) — the reset wiring kept proving it stale
    // every time, never silently trusting the stale completed-steps entry.
    expect(executedSteps.filter((s) => s === FILL_CONFIRM_PASSWORD)).toHaveLength(3);

    // Email/Password were genuinely still filled at failure time in both
    // dumps, so the filter correctly dropped their replan re-proposals —
    // they only ever ran once, during the original (non-replan) pass.
    expect(executedSteps.filter((s) => s === FILL_EMAIL)).toHaveLength(1);
    expect(executedSteps.filter((s) => s === FILL_PASSWORD)).toHaveLength(1);

    // Create Account ran three times total: the original failing attempt
    // plus one retry per replan cycle.
    expect(executedSteps.filter((s) => s === CLICK_CREATE_ACCOUNT)).toHaveLength(3);

    // Each replan's "dropped N bridge step(s)" log reflects exactly the two
    // genuinely-completed fields (Email, Password), never three — Confirm
    // Password was never swallowed into that drop count.
    const droppedLogs = loggerStub.info.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((msg) => msg.includes("dropped") && msg.includes("bridge step"));
    expect(droppedLogs).toHaveLength(2);
    for (const msg of droppedLogs) {
      expect(msg).toContain("dropped 2 bridge step(s)");
    }

    // The no-progress guard never fired — each cycle's bridge always
    // contained a genuinely new step (the Confirm Password refill).
    const abortLogged = loggerStub.error.mock.calls.some((call: unknown[]) =>
      String(call[0]).includes("no new bridge")
    );
    expect(abortLogged).toBe(false);
  });
});
