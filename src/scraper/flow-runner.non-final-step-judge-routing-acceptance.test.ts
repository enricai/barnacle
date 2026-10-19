import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { stepJudge, submitJudge } = vi.hoisted(() => ({
  stepJudge: vi.fn(),
  submitJudge: vi.fn(),
}));

vi.mock("@/lib/llm/judges/verify-step-advanced", () => ({
  verifyStepAdvancedWithLLM: stepJudge,
}));
vi.mock("@/lib/llm/judges/verify-submit", async (orig) => ({
  ...(await orig<object>()),
  verifySubmitWithLLM: submitJudge,
}));

import { executeStepWithHealing, judgeStepOutcome } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Acceptance for non-final submit-shaped step judging on a generic
 * multi-page form: the step-advanced judge decides (on settled post-click
 * text with before and after evidence), the final step keeps the submit
 * judge, and a null (unavailable) verdict with a demonstrable page advance
 * credits the step instead of failing it and re-clicking — on both the
 * main act() path and the n+16 el.click() fallback.
 */

const STEP = "Click 'Continue' to proceed to the next page of the form";
const URL = "https://example.org/application";

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
function buildWorld(sc: Scenario, actClicks: boolean): World {
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
    if (actClicks) (control as unknown as { click: () => void }).click();
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

const long = (s: string, n: number): string => `<p>${s.repeat(n)}</p>`;
const INITIAL = `<div><h1 id="hdr">Step 1</h1><div id="out">${long("Tell us your name and email address. ", 6)}</div><button id="theControl" type="submit">Continue</button></div>`;
const ADVANCED: Scenario = {
  name: "advance",
  initial: INITIAL,
  step: STEP,
  submitStep: true,
  mutate: (d) => {
    byId(d, "hdr").textContent = "Step 2";
    byId(d, "out").innerHTML = long("Choose your plan and billing frequency now. ", 6);
  },
};
const NOISE: Scenario = {
  ...ADVANCED,
  name: "noise",
  initial: `<div><h1 id="hdr">Create your account</h1><div id="out"><p>Enter your email and password below</p></div><button id="theControl" type="submit">Continue</button></div>`,
  mutate: (d) => {
    byId(d, "out").innerHTML = "<p>Enter your email and password below</p><p>Hint</p>";
  },
};

async function run(
  sc: Scenario,
  isFinalStep: boolean,
  actClicks: boolean
): Promise<{ outcome: unknown; world: World }> {
  const world = buildWorld(sc, actClicks);
  const outcome = await executeStepWithHealing({
    ...(params(world, isFinalStep, []) as object),
    step: sc.step,
    submitStep: sc.submitStep,
  } as never).catch((e) => `threw:${e}`);
  return { outcome, world };
}

describe("flow-runner non-final step judge routing acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    submitJudge.mockResolvedValue({ verified: false, reason: "x" });
  });

  it("credits a non-final step when the step judge says advanced, clicking once", async () => {
    stepJudge.mockResolvedValue({ advanced: true, reason: "moved on" });
    const { outcome, world } = await run(ADVANCED, false, true);
    expect(outcome).toBe("completed");
    expect(world.act).toHaveBeenCalledTimes(1);
    expect(stepJudge).toHaveBeenCalled();
    expect(submitJudge).not.toHaveBeenCalled();
  });

  it("passes settled before and after text to the step judge", async () => {
    stepJudge.mockResolvedValue({ advanced: true, reason: "moved on" });
    await run(ADVANCED, false, true);
    const input = stepJudge.mock.calls[0]?.[0].input;
    expect(input?.beforeText).toContain("Tell us your name");
    expect(input?.afterText).toContain("Choose your plan");
    expect(input?.afterText).not.toContain("Tell us your name");
  });

  it("does not verify a non-final step when the step judge says not advanced", async () => {
    stepJudge.mockResolvedValue({ advanced: false, reason: "same form" });
    const { outcome } = await run(NOISE, false, true);
    expect(outcome).not.toBe("completed");
  });

  it("routes the final step to the submit judge and never the step judge", async () => {
    submitJudge.mockResolvedValue({ verified: false, reason: "r" });
    await judgeStepOutcome({
      client: {} as never,
      step: STEP,
      isFinalStep: true,
      submitStep: false,
      flowHasSubmitSemantics: true,
      page: { waitForTimeout: async () => {} },
      target: { evaluate: async () => "Review and submit" } as never,
      signalCounter: { n: 0 },
      preNetworkCount: 0,
      preVisibleTextSignature: "4:Step",
      submitInput: {
        pageUrl: URL,
        pageTitle: "t",
        unfocusedObserve: [],
        networkCaptures: [],
        invalidMarkerCount: 0,
        ownBackendHostnames: [],
        successUrlFragments: [],
        successPageTitleHints: [],
        submittedStateSelectors: [],
      },
    });
    expect(submitJudge).toHaveBeenCalledTimes(1);
    expect(stepJudge).not.toHaveBeenCalled();
  });

  it("credits on a null step verdict with a page advance and does not re-click (main path)", async () => {
    stepJudge.mockResolvedValue(null);
    const { outcome, world } = await run(ADVANCED, false, true);
    expect(outcome).toBe("completed");
    expect(world.act).toHaveBeenCalledTimes(1);
  });

  it("credits on a null step verdict in the n+16 el.click() fallback without a repeat act()", async () => {
    stepJudge.mockResolvedValue(null);
    const { outcome, world } = await run(ADVANCED, false, false);
    expect(outcome).toBe("completed");
    expect(world.act).toHaveBeenCalledTimes(1);
  });

  it("does not credit a null step verdict when the page did not advance", async () => {
    stepJudge.mockResolvedValue(null);
    const { outcome } = await run(NOISE, false, true);
    expect(outcome).not.toBe("completed");
  });
});
