/**
 * Chains all three bugfix-001/002/003 fixes through one continuous run,
 * mirroring the report's actual failure shape (one run where a toggle-verdict
 * inconsistency drove churn that also doubled the replan budget across a
 * session retry) instead of exercising each fix in isolation:
 *
 * 1. Two same-page toggle steps (modeled on
 *    flow-runner.toggle-click-verdict-consistency-acceptance.test.ts's
 *    fixture) run through the REAL, unstubbed `executeStepWithHealing` /
 *    `runHealingFlow` cascade — one click grows the page body past the
 *    phantom-click trivial-byte floor, the other shrinks it — and both must
 *    verify identically via the element-scoped `data-selected` fingerprint
 *    on attempt 1 (bugfix-002: submit-semantics-scoped isFinalStep
 *    derivation).
 * 2. Neither toggle step burns a healing attempt or the replan budget to get
 *    there (bugfix-002's immediate-termination consequence).
 * 3. A separate step ahead of the toggles fails terminally and consumes the
 *    whole cascade-replan budget (`maxCascadeReplans=1`) via one replan; the
 *    flow then completes (through the toggle steps) and Stagehand's own CDP
 *    transport is discovered torn down post-loop, triggering a retry on a
 *    fresh session (mirrors
 *    recon-browser.cdp-transport-closed-mid-flow.test.ts). The fresh
 *    session's identical plan hits the same failing step again — this must
 *    see the budget already exhausted (bugfix-001's hoisted
 *    `cascadeReplansUsed`) rather than a silently reset 0/1, and abort
 *    immediately without a second replan LLM call.
 *
 * `executeStepWithHealing` is mocked only enough to make the budget-consuming
 * step and its LLM-proposed bridge step deterministic; every call for the
 * two toggle steps falls through to the real, unmocked implementation so the
 * verdict-consistency assertions exercise production code exactly as
 * flow-runner.toggle-click-verdict-consistency-acceptance.test.ts does.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
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
      maxCascadeReplans: 1,
      maxProbeReplans: 5,
      maxTransportRetries: 3,
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

const FAILING_STEP_INSTRUCTION = "Fill in the account-tier field";
const BRIDGE_STEP_INSTRUCTION = "Bridge step";

const { executeStepWithHealingSpy } = vi.hoisted(() => ({
  executeStepWithHealingSpy: vi.fn(),
}));
vi.mock("@/scraper/flow-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/flow-runner")>();
  const { StepVerificationError } =
    await vi.importActual<typeof import("@/scraper/errors")>("@/scraper/errors");
  return {
    ...actual,
    // Only the budget-consuming step and its LLM-proposed bridge are
    // stubbed; every other step (the two toggle clicks) falls through to
    // the real cascade so the verdict-consistency fix runs unmocked.
    executeStepWithHealing: vi.fn(async (params: { step: string }) => {
      executeStepWithHealingSpy(params.step);
      if (params.step === FAILING_STEP_INSTRUCTION) {
        throw new StepVerificationError(
          `step failed verification: ${params.step}`,
          "cascade-exhausted"
        );
      }
      if (params.step === BRIDGE_STEP_INSTRUCTION) {
        return "completed";
      }
      return actual.executeStepWithHealing(
        params as Parameters<typeof actual.executeStepWithHealing>[0]
      );
    }),
  };
});

// `stagehand-guard` is left unmocked — `guardedObserve` must run for real so
// the toggle steps' probe/cascade candidates come from the real production
// path, exactly like the unmocked toggle-verdict fixture test.

// A real Anthropic client is never constructed — replanRemainingFlow only
// needs `client.messages.parse`, so buildAnthropicClient returns a minimal
// stand-in with that one method stubbed.
const { messagesParseStub } = vi.hoisted(() => ({ messagesParseStub: vi.fn() }));
vi.mock("@/lib/llm/anthropic-client", () => ({
  buildAnthropicClient: () => ({ messages: { parse: messagesParseStub } }),
  buildRephraseModel: () => null,
}));

import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";

const BASE_URL = "https://dashboard.example.com/app/settings";

const SUPPORT_TAB_STEP = "Click the 'Support' tab to switch to it";
const BILLING_TAB_STEP = "Click the 'Billing' tab to switch to it";

/** Mirrors Stagehand's `nodeToAbsoluteXPath`: pure tag+sibling-position steps. */
function absoluteXPathFor(el: HappyDomElement): string {
  const steps: string[] = [];
  let node: HappyDomElement | null = el;
  while (node) {
    const currentNode: HappyDomElement = node;
    const parent: HappyDomElement | null = currentNode.parentElement;
    if (!parent) {
      steps.unshift(`${currentNode.tagName.toLowerCase()}[1]`);
      break;
    }
    const sameTag = Array.from(parent.children).filter(
      (c: HappyDomElement) => c.tagName === currentNode.tagName
    );
    const idx = sameTag.indexOf(currentNode) + 1;
    steps.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
    node = parent;
  }
  return `/${steps.join("/")}`;
}

function resolveAbsoluteXPath(root: HappyDomElement, xp: string): HappyDomElement | null {
  const steps = xp
    .split("/")
    .filter(Boolean)
    .map((step) => {
      const match = /^([a-zA-Z0-9]+)\[(\d+)\]$/.exec(step);
      if (!match) throw new Error(`unsupported xpath step in test fixture: ${step}`);
      return { tag: match[1]?.toUpperCase(), idx: Number(match[2]) };
    });
  let current: HappyDomElement | null = root;
  for (const step of steps.slice(1)) {
    if (!current) return null;
    const candidates: HappyDomElement[] = Array.from(current.children).filter(
      (c: HappyDomElement) => c.tagName === step.tag
    );
    current = candidates[step.idx - 1] ?? null;
  }
  return current;
}

function describeActInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

/** Real DOM fixture, real production `page.evaluate` expressions — for the two toggle steps. */
function makeTogglePage(): { page: Page; stagehand: Stagehand } {
  const window = new Window({ url: BASE_URL });
  const document = window.document;
  document.body.innerHTML = `
    <div class="tabWidget">
      <div role="listbox"></div>
      <input type="hidden" id="tabSupportState" />
      <input type="hidden" id="tabBillingState" />
    </div>
  `;

  const supportInputEl = document.getElementById("tabSupportState") as unknown as HappyDomElement;
  const billingInputEl = document.getElementById("tabBillingState") as unknown as HappyDomElement;
  const supportXPath = absoluteXPathFor(supportInputEl);
  const billingXPath = absoluteXPathFor(billingInputEl);

  // A large (~1500B) hidden padding node — big enough to cross the
  // phantom-click TRIVIAL_DOM_DELTA_BYTES floor (500) but well short of the
  // view-swap threshold (5000), so only the element-scoped dom credit can
  // verify either click.
  const PADDING = "x".repeat(1500);

  (
    supportInputEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    supportInputEl.setAttribute("data-selected", "true");
    const pad = document.createElement("div");
    pad.setAttribute("id", "tabPadding");
    pad.setAttribute("hidden", "true");
    pad.setAttribute("data-pad", PADDING);
    document.body.appendChild(pad);
  });

  (
    billingInputEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    billingInputEl.setAttribute("data-selected", "true");
    const pad = document.getElementById("tabPadding");
    pad?.remove();
  });

  const documentElement = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate = (
    expr: string
  ) => {
    const node = expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr);
    return { singleNodeValue: node };
  };

  const session = { on: (): void => {}, off: (): void => {} };
  const page: Page = {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: async (expr: unknown): Promise<unknown> => {
      const src = String(expr);
      const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
        d: unknown,
        x: unknown
      ) => unknown;
      return fn(document, win.XPathResult);
    },
    url: () => BASE_URL,
    title: async () => "Account Settings",
    locator: () => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async () => {},
    frames: vi.fn().mockReturnValue([]),
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: vi.fn().mockResolvedValue({ cookies: [] }),
  } as unknown as Page;

  const stagehand: Stagehand = {
    context: { awaitActivePage: async (): Promise<Page> => page },
    act: vi.fn().mockImplementation(async (input: unknown) => {
      const description = describeActInput(input);
      if (description.includes("Support")) {
        return {
          success: true,
          message: "clicked",
          actionDescription: SUPPORT_TAB_STEP,
          actions: [
            { selector: `xpath=${supportXPath}`, description: "Support tab", method: "click" },
          ],
        };
      }
      if (description.includes("Billing")) {
        return {
          success: true,
          message: "clicked",
          actionDescription: BILLING_TAB_STEP,
          actions: [
            { selector: `xpath=${billingXPath}`, description: "Billing tab", method: "click" },
          ],
        };
      }
      return {
        success: false,
        message: "no actionable candidate",
        actionDescription: description,
        actions: [],
      };
    }),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;

  return { page, stagehand };
}

/** Minimal page for the fresh (retried) session — the flow fails on the first, stubbed step before ever reaching the toggle DOM. */
function makeFakeMinimalPage(): { page: Page; stagehand: Stagehand } {
  const session = { on: (): void => {}, off: (): void => {} };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: (): string => BASE_URL,
    title: vi.fn().mockResolvedValue("Account Settings"),
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
  return { page, stagehand };
}

function flowArgv(): string[] {
  return [
    "node",
    "recon-browser.ts",
    "--url",
    BASE_URL,
    "--flow",
    JSON.stringify([FAILING_STEP_INSTRUCTION, SUPPORT_TAB_STEP, BILLING_TAB_STEP]),
  ];
}

describe("recon-browser/main — toggle-verdict + immediate-termination + cascade-budget-carryover chained in one flow", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-toggle-cascade-budget-"));
    process.env.RECON_RUN_ID = "20260917-000000-togglecascadebudget";
    process.env.RECON_OUT_DIR = runsRoot;
    loggerStub.info.mockClear();
    loggerStub.warn.mockClear();
    loggerStub.error.mockClear();
    executeStepWithHealingSpy.mockReset();
    messagesParseStub.mockReset();
    generateObjectStub.mockReset();
    vi.mocked(createBrowserSession).mockReset();
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
    executeStepWithHealingSpy.mockReset();
    messagesParseStub.mockReset();
  });

  it("verifies both toggle steps on attempt 1 via the real cascade, then carries the cascade-replan budget across a CDP-transport-retry instead of resetting it", async () => {
    const { page: togglePage, stagehand: session1Stagehand } = makeTogglePage();
    const { stagehand: session2Stagehand } = makeFakeMinimalPage();
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
      // Transport stays healthy on the retried session so the identical
      // step-0 failure surfaces as a StepVerificationError, not another
      // CDP-triggered retry.
      .mockResolvedValueOnce({
        stagehand: session2Stagehand,
        limiter: {} as never,
        sessionId: "test-session-2",
        provider: "browserbase",
        close: vi.fn().mockResolvedValue(undefined),
        getCdpTransportClosedError: () => undefined,
      } as never);

    // The one shared Haiku-judge client backs both the replan LLM call AND
    // the unfocused-observe modal-priority judge the replan's own candidate
    // render step invokes — dispatch on the system prompt so each gets a
    // response shaped for its own schema. The replan LLM call always
    // proposes the same single bridge step — called once on session 1
    // (consumes the only unit of budget) and must NEVER be called again on
    // session 2 if the budget correctly carried over (usedSoFar=1 >=
    // budget=1 aborts before reaching the LLM call).
    messagesParseStub.mockImplementation(async (args: { system?: string }) => {
      if (args.system?.includes("modal-priority")) {
        return {
          parsed_output: { priorityIndices: [], rationale: "no blocking modal detected" },
          content: [{ type: "text", text: "" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      return {
        parsed_output: { outcome: "replan", steps: [BRIDGE_STEP_INSTRUCTION] },
        content: [{ type: "text", text: "" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    });

    process.argv = flowArgv();

    // Session 1: step 0 fails terminally, consumes the entire cascade budget
    // via one replan, the bridged flow proceeds through the two real toggle
    // clicks (both effective on attempt 1), then the post-loop CDP-teardown
    // check fires and retries. Session 2's plan is the SAME original flow, so
    // step 0 fails identically — this must hit the exhausted-budget abort
    // immediately rather than being granted a fresh 0/1 budget.
    await expect(main()).rejects.toThrow(`step failed verification: ${FAILING_STEP_INSTRUCTION}`);

    expect(createBrowserSession).toHaveBeenCalledTimes(2);
    // Exactly one replan-proposal LLM call across the whole run — proves the
    // second session's budget check saw usedSoFar=1 (carried over) and
    // aborted before ever reaching replanRemainingFlow's LLM call again.
    // (The remaining messagesParseStub calls are the unfocused-observe
    // modal-priority judge the one replan's own candidate render invokes.)
    const replanProposalCalls = messagesParseStub.mock.calls.filter(
      (call) => !(call[0] as { system?: string }).system?.includes("modal-priority")
    );
    expect(replanProposalCalls).toHaveLength(1);
    expect(loggerStub.error).toHaveBeenCalledWith(
      expect.stringContaining("cascade-exhausted replan budget exhausted (1/1)")
    );

    // Session 1 actually reached and clicked both toggles, each exactly
    // once — proving neither needed a retry/escalation on top of the one
    // replan the earlier failing step consumed.
    expect(togglePage).toBeDefined();
    expect(session1Stagehand.act).toHaveBeenCalledTimes(2);
    expect(executeStepWithHealingSpy).toHaveBeenCalledWith(SUPPORT_TAB_STEP);
    expect(executeStepWithHealingSpy).toHaveBeenCalledWith(BILLING_TAB_STEP);
    // Session 2 never got far enough to touch the toggle steps at all — the
    // budget-exhausted abort on step 0 fired first.
    expect(
      executeStepWithHealingSpy.mock.calls.filter(([step]) => step === SUPPORT_TAB_STEP)
    ).toHaveLength(1);

    const infoLines = loggerStub.info.mock.calls.map((c) => String(c[0]));
    const warnLines = loggerStub.warn.mock.calls.map((c) => String(c[0]));

    // Both toggle clicks succeeded via the real cascade on the very first
    // attempt — the immediate-termination consequence of bugfix-002.
    const succeededLines = infoLines.filter((line) => line.includes("succeeded on attempt 1"));
    expect(succeededLines).toHaveLength(2);
    expect(infoLines.some((line) => line.includes("healed on attempt"))).toBe(false);

    // Both verified via the element-scoped selectionStateChanged signal,
    // with opposite-signed page-wide byte deltas — proving the consistent
    // "effective" verdict came from the authoritative per-element
    // fingerprint, not from both deltas happening to cross the same floor.
    const n16ProbeLines = infoLines.filter((line) => line.includes("n+16 probe:"));
    expect(n16ProbeLines).toHaveLength(2);
    for (const line of n16ProbeLines) {
      expect(line).toContain("selectionStateChanged=true");
      expect(line).toContain("verified=true");
    }
    const htmlDeltas = n16ProbeLines.map((line) => {
      const match = /htmlDelta=(-?\d+)/.exec(line);
      return match ? Number(match[1]) : Number.NaN;
    });
    expect(htmlDeltas[0]).toBeGreaterThan(500);
    expect(htmlDeltas[1]).toBeLessThan(0);

    // Neither toggle step ever logged a "no observable effect"-shaped
    // warning (the advance-DOM-veto / view-swap-blocked / phantom-click
    // messages the original report describes).
    const allLogged = [...infoLines, ...warnLines].join("\n");
    expect(allLogged).not.toContain("not treating as verified");
    expect(allLogged).not.toContain("phantom click");
  });
});
