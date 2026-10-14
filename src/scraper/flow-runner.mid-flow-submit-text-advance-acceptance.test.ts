import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * A non-final submit-shaped step is credited when the visible text
 * demonstrably advanced, even with no counted network, an unchanged URL, a
 * stale document title, an unchanged HTML size, a replaced clicked control,
 * a late body re-render, and a judge that rejects or is unavailable.
 */

vi.mock("@/lib/llm/judges/verify-submit", () => ({
  verifySubmitWithLLM: vi.fn(async () => ({
    verified: true,
    rationale: "order confirmation view visible",
    reason: "order confirmation view visible",
    dom_signal: null,
    url_signal: null,
  })),
}));

const STEP =
  "On the store checkout form (Shipping Address and Card Number already filled), click the 'Place Order' button to submit the order";
const URL = "https://example.org/checkout";

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

function byId(d: Doc, id: string): HappyDomElement {
  const el = d.getElementById(id) as unknown as HappyDomElement | null;
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

type Doc = InstanceType<typeof Window>["document"];

interface World {
  waits: number[];
  page: Page;
  stagehand: Stagehand;
  state: { rendered: boolean };
  counter: { n: number };
  act: ReturnType<typeof vi.fn>;
}

interface World {
  waits: number[];
  page: Page;
  stagehand: Stagehand;
  state: { rendered: boolean };
  counter: { n: number };
  act: ReturnType<typeof vi.fn>;
}

interface Scenario {
  name: string;
  initial: string;
  mutate: (d: Doc, ctl: HappyDomElement) => void;
  step: string;
  submitStep: boolean;
  title?: string;
  judge?: boolean;
  later?: { afterMs: number; fn: (d: Doc) => void };
  verdict?: null;
}
function buildWorld(sc: Scenario): World {
  const window = new Window({ url: URL });
  const document = window.document;
  document.body.innerHTML = sc.initial;
  const control = document.getElementById("theControl") as unknown as HappyDomElement;
  const controlXPath = xpathFor(control);
  const waits: number[] = [];
  const counter = { n: 0 };
  let now = 0;
  let clickedAt: number | null = null;
  let fired = false;
  (
    control as unknown as { addEventListener: (t: string, cb: () => void) => void }
  ).addEventListener("click", () => {
    clickedAt = now;
    sc.mutate(document as unknown as Doc, control);
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
    title: async () => sc.title ?? "Sign In",
    locator: () => ({
      first: () => ({
        click: async () => (control as unknown as { click: () => void }).click(),
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async (ms: number): Promise<void> => {
      waits.push(ms);
      now += ms;
      if (sc.later && !fired && clickedAt !== null && now - clickedAt >= sc.later.afterMs) {
        fired = true;
        sc.later.fn(document as unknown as Doc);
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
  return { page, stagehand, state: { rendered: true }, counter, act, waits };
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
  submitEndpointPattern: string | null = null
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
    submitEndpointPattern,
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

const long = (s: string, n: number) => `<p>${s.repeat(n)}</p>`;
const scenarios: Scenario[] = [
  {
    name: "header flips immediately, body re-renders 3s later, button replaced",
    step: "Click the 'Create Account' button to create the account",
    submitStep: true,
    initial: `<div><h1 id="hdr">Sign In</h1><div id="out">${long("Enter your credentials now please. ", 8)}</div><button id="theControl" type="submit">Create Account</button></div>`,
    mutate: (d) => {
      byId(d, "hdr").textContent = "Creating";
    },
    later: {
      afterMs: 3000,
      fn: (d) => {
        d.body.innerHTML = `<div><h1>Welcome</h1>${long("Your account is ready. ", 3)}</div>`;
      },
    },
  },
  {
    name: "unavailable judge, button replaced",
    verdict: null,
    step: "Click Register",
    submitStep: true,
    initial: `<div><h1 id="hdr">Sign In</h1><div id="out">${long("Enter your credentials now please. ", 8)}</div><button id="theControl" type="submit">Register</button></div>`,
    mutate: (d) => {
      d.body.innerHTML = `<div><h1>Verify</h1>${long("Code sent to your inbox. ", 3)}</div>`;
    },
  },
  {
    name: "header flip + body shrinks 41%",
    step: "Click the 'Create Account' button to create the account",
    submitStep: true,
    initial: `<div><h1 id="hdr">Sign In</h1><div id="out">${long("Welcome back please enter credentials. ", 20)}</div><button id="theControl" type="submit">Create Account</button></div>`,
    mutate: (d) => {
      byId(d, "hdr").textContent = "Welcome, Jane";
      byId(d, "out").innerHTML = long("Welcome back please enter credentials. ", 12);
    },
  },
  {
    name: "Continue text replaced by next wizard page",
    step: "Click 'Continue' to proceed",
    submitStep: true,
    initial: `<div><h1 id="hdr">Step 1</h1><div id="out">${long("Tell us your name and email address. ", 6)}</div><button id="theControl" type="submit">Continue</button></div>`,
    mutate: (d) => {
      byId(d, "hdr").textContent = "Step 2";
      byId(d, "out").innerHTML = long("Choose your plan and billing frequency now. ", 6);
    },
  },
  {
    name: "Register large text swap unchanged html size",
    step: "Click the Register button",
    submitStep: false,
    initial: `<div><h1 id="hdr">Register</h1><div id="out"><p>${"a".repeat(300)}</p></div><button id="theControl" type="submit">Register</button></div>`,
    mutate: (d) => {
      byId(d, "out").innerHTML = `<p>${"b".repeat(300)}</p>`;
    },
  },
  {
    name: "text-only change unchanged byte length",
    step: "Click Next",
    submitStep: true,
    initial: `<div><div id="out"><p>First screen content here ok</p></div><button id="theControl" type="submit">Next</button></div>`,
    mutate: (d) => {
      byId(d, "out").innerHTML =
        `<p>Other screen stuff here ok!</p>`.slice(0, 0) +
        `<p>First screen content here ok</p>`.split("").reverse().join("");
    },
  },
  {
    name: "different transition text grows",
    step: "Click 'Sign Up' to join",
    submitStep: true,
    initial: `<div><h1 id="hdr">Join</h1><div id="out"><p>Short</p></div><button id="theControl" type="submit">Sign Up</button></div>`,
    mutate: (d) => {
      byId(d, "hdr").textContent = "Verify";
      byId(d, "out").innerHTML = long("Check your inbox for the code we sent. ", 10);
    },
  },
];
const noise = {
  name: "tooltip-sized text change on a mid-flow submit",
  step: "Click 'Continue' to proceed",
  submitStep: true,
  initial: `<div><h1 id="hdr">Create your account</h1><div id="out"><p>Enter your email and password below</p></div><button id="theControl" type="submit">Continue</button></div>`,
  mutate: (d: Doc) => {
    byId(d, "out").innerHTML = "<p>Enter your email and password below</p><p>Hint</p>";
  },
} satisfies Scenario;

describe("flow-runner mid-flow submit text-advance (no network, stale title, judge rejecting or unavailable)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  for (const sc of scenarios) {
    it(sc.name, async () => {
      vi.mocked(verifySubmitWithLLM).mockResolvedValue(
        (sc.verdict === null ? null : { verified: false, reason: "x" }) as never
      );
      const world = buildWorld(sc);
      const p = {
        ...(params(world, false, []) as object),
        step: sc.step,
        submitStep: sc.submitStep,
      } as never;
      const outcome = await executeStepWithHealing(p).catch((e) => `threw:${e}`);
      expect({ outcome, attempts: world.act.mock.calls.length }).toMatchObject({
        outcome: "completed",
        attempts: 1,
      });
    });
  }

  it("does not credit a tooltip-sized text change", async () => {
    vi.mocked(verifySubmitWithLLM).mockResolvedValue({ verified: false, reason: "x" } as never);
    const world = buildWorld(noise);
    const p = {
      ...(params(world, false, []) as object),
      step: noise.step,
      submitStep: true,
    } as never;
    const outcome = await executeStepWithHealing(p).catch(() => "threw");
    expect(outcome).not.toBe("completed");
  });
});
