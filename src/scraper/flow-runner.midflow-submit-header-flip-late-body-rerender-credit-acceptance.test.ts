import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Report regression: a non-final submit-shaped click (account creation) whose header flips at
 * once but whose body re-renders seconds later, with no counted network, must
 * be credited as an advance at both the primary attempt site and the n+16
 * el.click() retry site — no phantom verdict, deep-submit/rephrase cascade or replan.
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

const STEP = "click the 'Create Account' button to submit the account creation form";
const URL = "https://acme.example/signup";
const RERENDER_DELAY_MS = 8000;
const PRE_HEADER = "Skip to main content Sign In Careers Home";
const POST_HEADER = "Skip to main content Settings Careers Home Candidate Home";
const PRE_TEXT = `${"Email Address Password Verify New Password. ".repeat(23)}`.slice(
  0,
  996 - PRE_HEADER.length
);
const POST_TEXT = `${"Welcome aboard, verify your inbox to continue. ".repeat(12)}`.slice(
  0,
  588 - POST_HEADER.length
);

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
  control: HappyDomElement;
  page: Page;
  stagehand: Stagehand;
  state: { rendered: boolean };
  counter: { n: number };
  act: ReturnType<typeof vi.fn>;
  clock: () => number;
}

function buildWorld(title: string, noop = false): World {
  const window = new Window({ url: URL });
  const document = window.document;
  document.body.innerHTML = `
    <div><h1 id="hdr">${PRE_HEADER}</h1>
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
    if (noop) return;
    clickedAt = now;
    hdr.textContent = POST_HEADER;
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
      if (clickedAt !== null && !state.rendered && now - clickedAt >= RERENDER_DELAY_MS) {
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
  return { page, stagehand, state, counter, act, control, clock: () => now };
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
    submitStep: true,
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

describe("flow-runner/executeStepWithHealing — header flip with late body re-render is credited", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("credits the primary attempt without phantom, cascade or replan", async () => {
    const world = buildWorld("Sign In");
    const trajectory: unknown[] = [];

    const outcome = await executeStepWithHealing(params(world, false, trajectory));

    expect(outcome).toBe("completed");
    expect(world.state.rendered).toBe(true);
    expect(world.clock()).toBeGreaterThanOrEqual(RERENDER_DELAY_MS);
    expect(world.counter.n).toBe(0);
    expect(world.act).toHaveBeenCalledTimes(1);
    expect(verifySubmitWithLLM).not.toHaveBeenCalled();
    expect(trajectory).toHaveLength(1);
    expect(logs().some((l) => /phantom|replan|deep-submit|rephras/i.test(l))).toBe(false);
  });

  it("credits the n+16 retry click without phantom, cascade or replan", async () => {
    const world = buildWorld("Sign In");
    world.act.mockImplementation(async () => ({
      success: true,
      message: "clicked",
      actionDescription: "clicked",
      actions: [
        { selector: `xpath=${xpathFor(world.control)}`, description: "control", method: "click" },
      ],
    }));
    const trajectory: unknown[] = [];

    const outcome = await executeStepWithHealing(params(world, false, trajectory));

    expect(outcome).toBe("completed");
    expect(world.state.rendered).toBe(true);
    expect(world.counter.n).toBe(0);
    expect(world.act).toHaveBeenCalledTimes(1);
    expect(trajectory).toHaveLength(1);
    expect(logs().some((l) => /n\+16/.test(l))).toBe(true);
    expect(logs().some((l) => /phantom|replan|deep-submit|rephras/i.test(l))).toBe(false);
  });

  it("credits a retry attempt whose page already advanced with exactly one click", async () => {
    const world = buildWorld("Sign In");
    let clicks = 0;
    (
      world.control as unknown as { addEventListener: (t: string, cb: () => void) => void }
    ).addEventListener("click", () => {
      clicks += 1;
    });
    world.act.mockImplementation(async () => {
      (world.control as unknown as { click: () => void }).click();
      throw new Error("act errored after the click landed");
    });
    const trajectory: unknown[] = [];

    const outcome = await executeStepWithHealing(params(world, false, trajectory));

    expect(outcome).toBe("completed");
    expect(world.state.rendered).toBe(true);
    expect(clicks).toBe(1);
    expect(world.act).toHaveBeenCalledTimes(1);
    expect(logs().some((l) => /phantom|replan|deep-submit|rephras/i.test(l))).toBe(false);
  });

  it("credits a step whose submit shape is only known from the resolved element", async () => {
    const world = buildWorld("Sign In");
    const onBaseline = vi.fn();
    const p = params(world, false, []) as unknown as Record<string, unknown>;
    p.step = "On the registration form, click the 'Create Account' button";
    p.submitStep = false;
    p.onElementStepStartBaseline = onBaseline;

    const outcome = await executeStepWithHealing(p as never);

    expect(outcome).toBe("completed");
    expect(world.state.rendered).toBe(true);
    expect(world.act).toHaveBeenCalledTimes(1);
    expect(onBaseline).toHaveBeenCalledTimes(1);
    expect(logs().some((l) => /phantom|replan|deep-submit|rephras/i.test(l))).toBe(false);
  });

  it("keeps a genuine no-op click phantom: nothing changes, so the step still throws", async () => {
    const world = buildWorld("Sign In", true);

    await expect(executeStepWithHealing(params(world, false, []))).rejects.toThrow(
      /failed verification|phantom-click-exhausted/
    );
    expect(world.state.rendered).toBe(false);
  });

  it("keeps network/URL proof for a genuine final submit: DOM text alone is not credited", async () => {
    const world = buildWorld("Sign In");

    await expect(executeStepWithHealing(params(world, true, []))).rejects.toThrow(
      /failed verification/
    );
  });
});
