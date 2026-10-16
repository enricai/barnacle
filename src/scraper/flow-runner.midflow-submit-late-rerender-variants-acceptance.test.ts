import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Contract regression over variants of the report shape (wording, late-by-N-seconds, body
 * growing vs shrinking, one-step swap): a non-final submit-shaped click whose
 * header flips then re-renders late must be credited on attempt 1 and never
 * judged on the half-transitioned snapshot. Report regression: a non-final submit-shaped click (account creation) whose header flips at
 * once but whose main body re-renders ~8s later, with no counted network, must
 * be credited on attempt 1 — while the same shape as the final submit stays
 * uncredited.
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

const STEP =
  "On the account registration form (Email Address, Password and Verify New Password already filled), click the 'Create Account' button to submit the account creation form";
const URL = "https://example.org/signup";
const IDLE_GIVE_UP_MS = 14_000;
const STEP_PAUSE_MS = 2_000;

interface Variant {
  name: string;
  step: string;
  preHeader: string;
  postHeader: string;
  preText: string;
  postText: string;
  headerFirst: boolean;
  delayMs: number;
}

const SHRINK_PRE = "Email Address Password Verify New Password. ".repeat(21).slice(0, 980);
const SHRINK_POST = "Welcome aboard, verify your inbox to continue. ".repeat(12).slice(0, 580);
const GROW_PRE = "Email Address Password. ".repeat(5);
const GROW_POST = "Pick a plan and enter billing details to start. ".repeat(30);
const REPORT: Variant = {
  name: "report example",
  step: STEP,
  preHeader: "Sign In",
  postHeader: "My Account",
  preText: SHRINK_PRE,
  postText: SHRINK_POST,
  headerFirst: true,
  delayMs: 8000,
};
const VARIANTS: Variant[] = [
  REPORT,
  { ...REPORT, name: "late by 13s", delayMs: 13_000 },
  { ...REPORT, name: "late by 25s", delayMs: 25_000 },
  {
    ...REPORT,
    name: "body grows, late by 10s",
    preText: GROW_PRE,
    postText: GROW_POST,
    delayMs: 10_000,
  },
  {
    ...REPORT,
    name: "body grows, late by 15s",
    preText: GROW_PRE,
    postText: GROW_POST,
    delayMs: 15_000,
  },
  {
    ...REPORT,
    name: "one-step swap, other wording",
    step: "Click the 'Register' button to submit the sign up form",
    preHeader: "Join Now",
    postHeader: "Dashboard",
    headerFirst: false,
    delayMs: 0,
  },
  {
    ...REPORT,
    name: "other wording, late by 12s",
    step: "Press Continue to create the account",
    preHeader: "Create your login",
    postHeader: "Verify your email",
    delayMs: 12_000,
  },
];

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

function buildWorld(title: string, v: Variant): World {
  const window = new Window({ url: URL });
  const document = window.document;
  document.body.innerHTML = `
    <div><h1 id="hdr">${v.preHeader}</h1>
    <form id="theForm"><button id="theControl" type="submit">Create Account</button></form>
    <div id="out"><p>${v.preText}</p></div></div>`;
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
    hdr.textContent = v.postHeader;
    if (v.headerFirst) return;
    out.innerHTML = `<p>${v.postText}</p>`;
    state.rendered = true;
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
      if (clickedAt !== null && !state.rendered && now - clickedAt >= v.delayMs) {
        state.rendered = true;
        out.innerHTML = `<p>${v.postText}</p>`;
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
  step: string = STEP,
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

describe("flow-runner/executeStepWithHealing — mid-flow submit credited once the page finishes re-rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const variant of VARIANTS) {
    it(`credits attempt 1 with no counted network and a stale title: ${variant.name}`, async () => {
      vi.mocked(verifySubmitWithLLM).mockResolvedValue({
        verified: false,
        reason: "no network or url evidence",
      } as never);
      const world = buildWorld("Sign In", variant);
      const trajectory: unknown[] = [];

      const outcome = await executeStepWithHealing(params(world, false, trajectory, variant.step));

      expect(outcome).toBe("completed");
      expect(world.state.rendered).toBe(true);
      expect(world.counter.n).toBe(0);
      expect(world.act).toHaveBeenCalledTimes(1);
      expect(trajectory).toHaveLength(1);
      expect(logs().some((l) => /phantom-click-exhausted|replan|phantom click/i.test(l))).toBe(
        false
      );
    });
  }

  it("waits past the quiet window for a body re-render when only the header words flipped on an instruction-inferred submit", async () => {
    vi.mocked(verifySubmitWithLLM).mockResolvedValue({
      verified: false,
      reason: "no network or url evidence",
    } as never);
    const world = buildWorld("Sign In", { ...REPORT, delayMs: 10_000 });
    const trajectory: unknown[] = [];

    const outcome = await executeStepWithHealing(params(world, false, trajectory, STEP, false));

    expect(outcome).toBe("completed");
    expect(world.state.rendered).toBe(true);
    expect(world.act).toHaveBeenCalledTimes(1);
    expect(trajectory).toHaveLength(1);
  });

  it("does not credit a submit-shaped click that changes nothing", async () => {
    vi.mocked(verifySubmitWithLLM).mockResolvedValue({
      verified: false,
      reason: "nothing changed",
    } as never);
    const world = buildWorld("Sign In", REPORT);
    world.act.mockImplementation(async () => ({
      success: true,
      message: "clicked",
      actionDescription: "clicked",
      actions: [],
    }));

    const outcome = await executeStepWithHealing(params(world, false, [])).catch(() => "threw");

    expect(outcome).not.toBe("completed");
    expect(world.clock()).toBeGreaterThanOrEqual(STEP_PAUSE_MS + IDLE_GIVE_UP_MS);
  });

  it("keeps demanding network/URL proof for the final-position submit", async () => {
    vi.mocked(verifySubmitWithLLM).mockResolvedValue({
      verified: false,
      reason: "no network or url evidence",
    } as never);
    const world = buildWorld("Sign In", REPORT);

    const outcome = await executeStepWithHealing(params(world, true, [])).catch(() => "threw");

    expect(outcome).not.toBe("completed");
  });
});
