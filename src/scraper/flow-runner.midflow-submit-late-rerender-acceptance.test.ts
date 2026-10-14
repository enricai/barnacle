import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * A non-final submit-shaped click (account creation) whose header flips at
 * once but whose main body re-renders ~8s later, with no counted network, must
 * be credited on attempt 1 — while the same shape as the final submit stays
 * uncredited.
 */

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
const RERENDERED_TEXT = "Welcome aboard, verify your inbox to continue";

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
}

function buildWorld(title: string): World {
  const window = new Window({ url: URL });
  const document = window.document;
  document.body.innerHTML = `
    <div><h1 id="hdr">Sign up</h1>
    <form id="theForm"><button id="theControl" type="submit">Create Account</button></form>
    <div id="out"><p>Fill the form</p></div></div>`;
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
    hdr.textContent = "Creating your account";
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
        hdr.textContent = "Account created";
        out.innerHTML = `<p data-r="${"x".repeat(6000)}">${RERENDERED_TEXT}</p>`;
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
  return { page, stagehand, state, counter, act };
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

describe("flow-runner/executeStepWithHealing — mid-flow submit with late text-only re-render", () => {
  beforeEach(() => {
    vi.mocked(verifySubmitWithLLM).mockClear();
    vi.clearAllMocks();
  });

  it("credits a non-final submit-shaped click on attempt 1 without escalation", async () => {
    const world = buildWorld("Sign up");
    const trajectory: unknown[] = [];

    const outcome = await executeStepWithHealing(params(world, false, trajectory));

    expect(world.state.rendered).toBe(true);
    expect(outcome).toBe("completed");
    expect(world.act).toHaveBeenCalledTimes(1);
    const logs = vi
      .mocked(testLogger.info)
      .mock.calls.concat(vi.mocked(testLogger.warn).mock.calls)
      .map((c) => String(c[0]));
    expect(logs.some((l) => l.includes("deep-submit-locator") || l.includes("llm-rephrase"))).toBe(
      false
    );
    expect(logs.some((l) => l.includes("phantom-click-exhausted"))).toBe(false);
  });

  it("hands the judge the re-rendered text for a stale-title non-final step", async () => {
    const world = buildWorld("Sign In");

    const outcome = await executeStepWithHealing(params(world, false, []));

    expect(outcome).toBe("completed");
    const calls = vi.mocked(verifySubmitWithLLM).mock.calls;
    for (const [arg] of calls) {
      expect(arg.input.pageTitle).toBe("Sign In");
      expect(arg.input.isFinalStep).toBe(false);
      expect(arg.input.visibleText).toContain(RERENDERED_TEXT);
    }
  });

  it("does not credit the same DOM-only change on the final submit", async () => {
    vi.mocked(verifySubmitWithLLM).mockResolvedValue({
      verified: false,
      reason: "no network or url evidence",
    } as never);
    const world = buildWorld("Sign up");

    const outcome = await executeStepWithHealing(params(world, true, [])).catch(() => "threw");

    expect(outcome).not.toBe("completed");
  });
});
