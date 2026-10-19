import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * An unflagged, non-submit-worded click whose control is submit-shaped must stay
 * mid-flow when the page swaps at once and removes that control: the shape is
 * read from the target observe resolved before the click, so the transition the
 * click caused cannot blind it. A no-op and the genuine final submit keep their
 * strict outcome.
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

const STEP = "Click the 'Create Account' button";
const URL = "https://example.org/signup";
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
  counter: { n: number };
  act: ReturnType<typeof vi.fn>;
  clock: () => number;
}

function buildWorld(swapsPage: boolean): World {
  const window = new Window({ url: URL });
  const document = window.document;
  document.body.innerHTML = `
    <div><h1 id="hdr">Sign In</h1>
    <form id="theForm"><button id="theControl" type="submit">Create Account</button></form>
    <div id="out"><p>${PRE_TEXT}</p></div></div>`;
  const control = document.getElementById("theControl") as unknown as HappyDomElement;
  const controlXPath = xpathFor(control);
  (control as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  (document as unknown as { elementFromPoint: () => unknown }).elementFromPoint = () => control;

  let now = 0;
  const counter = { n: 0 };
  (
    control as unknown as { addEventListener: (t: string, cb: () => void) => void }
  ).addEventListener("click", () => {
    if (!swapsPage) return;
    document.body.innerHTML = `<div><h1>My Account</h1><div><p>${POST_TEXT}</p></div></div>`;
  });

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
    title: async () => "Sign In",
    locator: () => ({
      first: () => ({
        click: async () => (control as unknown as { click: () => void }).click(),
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async (ms: number): Promise<void> => {
      now += ms;
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
        typeof i === "string"
          ? [{ selector: `xpath=${controlXPath}`, description: "control", method: "click" }]
          : [{ selector: "xpath=//probe-presence", description: "p" }]
      ),
  } as unknown as Stagehand;
  return { page, stagehand, counter, act, clock: () => now };
}

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function params(world: World, isFinalStep: boolean, trajectory: unknown[]): never {
  return {
    stagehand: world.stagehand,
    page: world.page,
    step: STEP,
    optional: false,
    upload: false,
    submitStep: false,
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
    flowHasSubmitSemantics: isFinalStep,
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

describe("flow-runner/executeStepWithHealing — submit shape read before the click removes the control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("credits attempt 1 when the whole page swaps at once, removing the control, with no counted network", async () => {
    vi.mocked(verifySubmitWithLLM).mockResolvedValue({
      verified: false,
      reason: "stale title",
    } as never);
    const world = buildWorld(true);
    const trajectory: unknown[] = [];

    const outcome = await executeStepWithHealing(params(world, false, trajectory));

    expect(outcome).toBe("completed");
    expect(world.counter.n).toBe(0);
    expect(world.act).toHaveBeenCalledTimes(1);
    expect(trajectory).toHaveLength(1);
    expect(logs().some((l) => /phantom-click-exhausted|replan/i.test(l))).toBe(false);
  });

  it("does not credit a genuine no-op click", async () => {
    vi.mocked(verifySubmitWithLLM).mockResolvedValue({
      verified: false,
      reason: "nothing changed",
    } as never);
    const world = buildWorld(false);

    const outcome = await executeStepWithHealing(params(world, false, [])).catch(() => "threw");

    expect(outcome).not.toBe("completed");
    expect(world.clock()).toBeGreaterThanOrEqual(STEP_PAUSE_MS + IDLE_GIVE_UP_MS);
  });

  it("does not credit the genuine final submit on the same page swap", async () => {
    vi.mocked(verifySubmitWithLLM).mockResolvedValue({
      verified: false,
      reason: "no network or url evidence",
    } as never);
    const world = buildWorld(true);

    const outcome = await executeStepWithHealing(params(world, true, [])).catch(() => "threw");

    expect(outcome).not.toBe("completed");
  });
});
