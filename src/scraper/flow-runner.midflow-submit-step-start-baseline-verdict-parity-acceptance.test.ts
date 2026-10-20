import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifyStepAdvancedWithLLM } from "@/lib/llm/judges/verify-step-advanced";
import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Verdict parity against the step-start baseline: a non-final submit-shaped click whose header
 * flips at once and whose body re-renders ~8s later (no counted network, stale title) must be
 * credited at the attempt-2+ entry (per-attempt `pre` already absorbed the re-render) and at the
 * n+16 el.click() retry verdict — one click, no phantom, cascade or replan.
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
const RERENDER_DELAY_MS = 8000;
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
    <div><h1 id="hdr">Sign In</h1>
    <form id="theForm"><button id="theControl" type="submit">Create Account</button></form>
    <div id="out"><p>${PRE_TEXT}</p></div></div>`;
  const control = document.getElementById("theControl") as unknown as HappyDomElement;
  const hdr = document.getElementById("hdr") as unknown as HappyDomElement;
  const out = document.getElementById("out") as unknown as HappyDomElement;
  const controlXPath = xpathFor(control);
  (control as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  (document as unknown as { elementFromPoint: () => unknown }).elementFromPoint = () => control;

  let now = 0;
  let clickedAt: number | null = null;
  const state = { rendered: false };
  const counter = { n: 0 };
  const click = (): void => {
    if (noop) return;
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

function params(
  world: World,
  isFinalStep: boolean,
  trajectory: unknown[],
  overrides: Record<string, unknown> = {}
): never {
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
    ...overrides,
  } as never;
}

function logs(): string[] {
  return vi
    .mocked(testLogger.info)
    .mock.calls.concat(vi.mocked(testLogger.warn).mock.calls)
    .map((c) => String(c[0]));
}

describe("flow-runner/executeStepWithHealing — step-start baseline verdict parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("credits attempt 2+ whose per-attempt pre already absorbed the re-render, with one click", async () => {
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
    expect(world.counter.n).toBe(0);
    expect(clicks).toBe(1);
    expect(world.act).toHaveBeenCalledTimes(1);
    expect(verifySubmitWithLLM).not.toHaveBeenCalled();
    expect(logs().some((l) => /phantom|replan|deep-submit|rephras/i.test(l))).toBe(false);
  });

  it("credits via the n+16 retry verdict with exactly one act and no replan", async () => {
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

  it("seeds the primary judge call from the step-start page, not the attempt-local pre", async () => {
    const world = buildWorld("Sign In");
    world.act.mockImplementation(async () => {
      (world.control as unknown as { click: () => void }).click();
      throw new Error("act errored after the click landed");
    });

    const outcome = await executeStepWithHealing(params(world, false, []));

    expect(outcome).toBe("completed");
    expect(world.counter.n).toBe(0);
    const inputs = vi
      .mocked(verifyStepAdvancedWithLLM)
      .mock.calls.map((c) => c[0].input.beforeText);
    // the step-start credit often lands before the judge runs; any judge call must still be step-start seeded
    for (const before of inputs) {
      expect(before).toContain("Sign In");
      expect(before).not.toContain("My Account");
    }
  });

  it("seeds the n+16 retry judge call from the step-start page, not the attempt-local pre", async () => {
    const world = buildWorld("Sign In");
    world.act.mockImplementation(async () => ({
      success: true,
      message: "clicked",
      actionDescription: "clicked",
      actions: [
        { selector: `xpath=${xpathFor(world.control)}`, description: "control", method: "click" },
      ],
    }));

    const outcome = await executeStepWithHealing(params(world, false, []));

    expect(outcome).toBe("completed");
    expect(world.counter.n).toBe(0);
    expect(logs().some((l) => /n\+16/.test(l))).toBe(true);
    const inputs = vi
      .mocked(verifyStepAdvancedWithLLM)
      .mock.calls.map((c) => c[0].input.beforeText);
    expect(inputs.length).toBeGreaterThan(0);
    for (const before of inputs) {
      expect(before).toContain("Sign In");
      expect(before).not.toContain("My Account");
    }
  });

  it("still treats a genuine no-op click as phantom at the same verdict sites", async () => {
    const world = buildWorld("Sign In", true);

    await expect(executeStepWithHealing(params(world, false, []))).rejects.toThrow(
      /failed verification|phantom-click-exhausted/
    );
    expect(world.state.rendered).toBe(false);
  });

  it("keeps the step-start page as the baseline when attempt 1's act threw before resolving anything", async () => {
    const world = buildWorld("Sign In");
    const baselines: Array<{ visibleTextSignature?: string }> = [];
    (world.stagehand.observe as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (i?: unknown) =>
        typeof i === "string"
          ? [
              {
                selector: `xpath=${xpathFor(world.control)}`,
                description: "highlighted control",
                method: "click",
                arguments: [],
              },
            ]
          : [{ selector: "xpath=//probe-presence", description: "p" }]
    );
    let acts = 0;
    world.act.mockImplementation(async () => {
      acts += 1;
      (world.control as unknown as { click: () => void }).click();
      if (acts === 1) throw new Error("act errored after the click landed");
      return {
        success: true,
        message: "clicked",
        actionDescription: "clicked",
        actions: [
          { selector: `xpath=${xpathFor(world.control)}`, description: "control", method: "click" },
        ],
      };
    });
    const outcome = await executeStepWithHealing(
      params(world, false, [], {
        step: "On the registration form, press the highlighted control",
        submitStep: false,
        onElementStepStartBaseline: (snapshot: { visibleTextSignature?: string }) =>
          baselines.push(snapshot),
      })
    );

    expect(outcome).toBe("completed");
    expect(baselines).toHaveLength(1);
    expect(baselines[0]?.visibleTextSignature).toContain("Sign In");
    expect(baselines[0]?.visibleTextSignature).not.toContain("My Account");
    expect(logs().some((l) => /phantom|replan|deep-submit|rephras/i.test(l))).toBe(false);
  });
});
