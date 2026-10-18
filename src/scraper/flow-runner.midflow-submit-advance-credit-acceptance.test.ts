import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Campaign contract, end to end: a mid-flow submit-shaped click whose page
 * demonstrably advances (header flips at once, body re-renders later, no
 * counted network) is credited once settled; a genuine no-op still gives up on
 * the idle timeline; a stale title never blocks a non-final verdict while the
 * final submit keeps strict proof; and a non-submit reveal click is unaffected.
 */

vi.mock("@/lib/llm/judges/verify-step-advanced", () => ({
  verifyStepAdvancedWithLLM: vi.fn(async () => ({ advanced: false, reason: "no change" })),
}));

vi.mock("@/lib/llm/judges/verify-submit", () => ({
  verifySubmitWithLLM: vi.fn(async () => ({
    verified: true,
    rationale: "account created view visible",
    reason: "account created view visible",
    dom_signal: null,
    url_signal: null,
  })),
}));

const SUBMIT_STEP =
  "On the account registration form (Email Address, Password and Verify New Password already filled), click the 'Create Account' button to submit the account creation form";
const URL = "https://example.org/signup";
const REVEAL_STEP = "Click the 'Show details' button to reveal the additional details section";
const IDLE_GIVE_UP_MS = 14_000;
const STEP_PAUSE_MS = 2_000;
const PRE_TEXT = `Sign In ${"Email Address Password Verify New Password. ".repeat(21)}`.slice(
  0,
  996
);
const POST_TEXT =
  `My Account ${"Welcome aboard, verify your inbox to continue. ".repeat(12)}`.slice(0, 588);

function xpathFor(el: HappyDomElement): string {
  const parts: string[] = [];
  let node: HappyDomElement | null = el;
  while (node) {
    const cur: HappyDomElement = node;
    const parent: HappyDomElement | null = cur.parentElement;
    if (!parent) {
      parts.unshift(`${cur.tagName.toLowerCase()}[1]`);
      break;
    }
    const same = Array.from(parent.children).filter(
      (c: HappyDomElement) => c.tagName === cur.tagName
    );
    parts.unshift(`${cur.tagName.toLowerCase()}[${same.indexOf(cur) + 1}]`);
    node = parent;
  }
  return `/${parts.join("/")}`;
}

function resolveXPath(root: HappyDomElement, xp: string): HappyDomElement | null {
  let current: HappyDomElement | null = root;
  for (const part of xp.split("/").filter(Boolean).slice(1)) {
    const m = /^([a-zA-Z0-9]+)\[(\d+)\]$/.exec(part);
    if (!current || !m) return null;
    const kids: HappyDomElement[] = Array.from(current.children).filter(
      (c: HappyDomElement) => c.tagName === m[1]?.toUpperCase()
    );
    current = kids[Number(m[2]) - 1] ?? null;
  }
  return current;
}

interface World {
  page: Page;
  stagehand: Stagehand;
  state: { rendered: boolean };
  counter: { n: number };
  act: ReturnType<typeof vi.fn>;
  clock: () => number;
}

function buildWorld(title: string, rerenderDelayMs = 8000): World {
  const window = new Window({ url: URL });
  const document = window.document;
  document.body.innerHTML = `
    <div><h1 id="hdr">Sign In</h1>
    <form id="theForm"><button id="theControl" type="submit">Create Account</button></form>
    <div id="out"><p>${PRE_TEXT}</p></div></div>`;
  const control = document.getElementById("theControl") as unknown as HappyDomElement;
  const hdr = document.getElementById("hdr") as unknown as HappyDomElement;
  const out = document.getElementById("out") as unknown as HappyDomElement;
  const controlXPath = xpathFor(control);

  let now = 0;
  let clickedAt: number | null = null;
  const state = { rendered: false };
  const counter = { n: 0 };
  const click = (): void => {
    clickedAt = now;
    hdr.textContent = "My Account";
  };
  (
    control as unknown as { addEventListener: (t: string, cb: () => void) => void }
  ).addEventListener("click", click);

  const root = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (e: string) => { singleNodeValue: unknown } }).evaluate = (
    e: string
  ) => ({ singleNodeValue: e.startsWith("//") ? null : resolveXPath(root, e) });

  const session = { on: () => {}, off: () => {} };
  const page = {
    evaluate: async (expr: unknown): Promise<unknown> =>
      (
        new window.Function("document", "XPathResult", `return (${String(expr)});`) as (
          d: unknown,
          x: unknown
        ) => unknown
      )(document, win.XPathResult),
    url: () => URL,
    title: async () => title,
    locator: () => ({
      first: () => ({
        click: async () => (control as unknown as { click: () => void }).click(),
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async (ms: number): Promise<void> => {
      now += ms;
      if (clickedAt !== null && !state.rendered && now - clickedAt >= rerenderDelayMs) {
        state.rendered = true;
        out.innerHTML = `<p>${POST_TEXT}</p>`;
      }
    },
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;

  const act = vi.fn().mockImplementation(async () => {
    (control as unknown as { click: () => void }).click();
    return {
      success: true,
      message: "clicked",
      actionDescription: "clicked",
      actions: [{ selector: `xpath=${controlXPath}`, description: "control", method: "click" }],
    };
  });
  const stagehand = {
    act,
    observe: vi
      .fn()
      .mockImplementation(async (i?: unknown) =>
        typeof i === "string" ? [] : [{ selector: "xpath=//probe-presence", description: "p" }]
      ),
  } as unknown as Stagehand;
  return { page, stagehand, state, counter, act, clock: () => now };
}

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function params(
  world: World,
  isFinalStep: boolean,
  trajectory: unknown[],
  step = SUBMIT_STEP,
  submitStep = true
): never {
  return {
    stagehand: world.stagehand,
    page: world.page,
    step,
    optional: false,
    upload: false,
    submitStep,
    stepIndex: 0,
    totalSteps: () => 2,
    phase: "flow",
    signalCounter: world.counter,
    trajectory,
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: {},
    rephraseModel: null,
    logger: testLogger,
    uploadFixture: null,
    isFinalStep,
    flowHasSubmitSemantics: isFinalStep && submitStep,
    submitEndpointPattern: null,
    submittedStateSelectors: [],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: null,
    successUrlFragments: [],
    successPageTitleHints: [],
    ownBackendHostnames: [],
    knownErrorClassPrefixes: [],
    wizardExitButtonLabels: [],
  } as never;
}

function logs(): string[] {
  return vi
    .mocked(testLogger.info)
    .mock.calls.concat(vi.mocked(testLogger.warn).mock.calls)
    .map((c) => String(c[0]));
}

describe("flow-runner/executeStepWithHealing — mid-flow submit advance credit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([8000, 12_000])(
    "credits attempt 1 when the header flips at once and the body re-renders %ims later with no counted network",
    async (delay) => {
      const world = buildWorld("Sign In", delay);
      const trajectory: unknown[] = [];

      const outcome = await executeStepWithHealing(params(world, false, trajectory));

      expect(outcome).toBe("completed");
      expect(world.state.rendered).toBe(true);
      expect(world.counter.n).toBe(0);
      expect(world.act).toHaveBeenCalledTimes(1);
      expect(trajectory).toHaveLength(1);
      expect(logs().some((l) => /phantom-click-exhausted|replan/i.test(l))).toBe(false);
    }
  );

  it("does not credit a submit-flagged no-op click and gives up at the idle timeline", async () => {
    vi.mocked(verifySubmitWithLLM).mockResolvedValue({
      verified: false,
      reason: "nothing changed",
    } as never);
    const world = buildWorld("Sign In");
    world.act.mockImplementation(async () => ({
      success: true,
      message: "clicked",
      actionDescription: "clicked",
      actions: [],
    }));
    const trajectory: unknown[] = [];

    const outcome = await executeStepWithHealing(params(world, false, trajectory)).catch(
      () => "threw"
    );

    expect(outcome).not.toBe("completed");
    expect(world.state.rendered).toBe(false);
    expect(trajectory).toHaveLength(0);
    expect(world.clock()).toBeGreaterThanOrEqual(STEP_PAUSE_MS + IDLE_GIVE_UP_MS);
    expect(logs().some((l) => /phantom/i.test(l))).toBe(true);
  });

  it("verifies a non-final step with a stale title, while the final step stays strict", async () => {
    const nonFinal = await executeStepWithHealing(
      params(buildWorld("Sign In"), false, [])
    );
    expect(nonFinal).toBe("completed");

    vi.mocked(verifySubmitWithLLM).mockResolvedValue({
      verified: false,
      reason: "no network or url evidence",
    } as never);
    const finalOutcome = await executeStepWithHealing(
      params(buildWorld("Sign In"), true, [])
    ).catch(() => "threw");
    expect(finalOutcome).not.toBe("completed");
  });

  it("still credits a non-submit reveal click from its ordinary DOM delta on attempt 1", async () => {
    const world = buildWorld("Sign In", 0);
    const trajectory: unknown[] = [];

    const outcome = await executeStepWithHealing(
      params(world, false, trajectory, REVEAL_STEP, false)
    );

    expect(outcome).toBe("completed");
    expect(world.act).toHaveBeenCalledTimes(1);
    expect(trajectory).toHaveLength(1);
  });
});
