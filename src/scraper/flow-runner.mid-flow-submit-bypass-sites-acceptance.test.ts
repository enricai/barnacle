import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RephraseModel } from "@/lib/llm/anthropic-client";
import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * A mid-flow submit-shaped step whose click only advances the page after a late
 * DOM-only re-render must be credited identically whichever escalation site
 * issued the click (deep-submit-locator, runner-up re-classification,
 * llm-rephrase), while a click that never advances still ends phantom.
 */

const { generateObjectMock } = vi.hoisted(() => ({ generateObjectMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: generateObjectMock };
});

vi.mock("@/lib/llm/judges/verify-submit", () => ({
  verifySubmitWithLLM: vi.fn(async () => ({ verified: false, reason: "no evidence" })),
}));

const STEP =
  "On the account registration form (Email Address, Password and Verify New Password already filled), click the 'Create Account' button to submit the account creation form";
const REPHRASED = "Press the Create Account control at the bottom of the registration form";
const URL = "https://example.org/signup";
const RERENDER_DELAY_MS = 12000;
const PRE_TEXT_LEN = 996;
const POST_TEXT_LEN = 588;
const PRE_BYTES = 31284;
const POST_BYTES = 29300;

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

type Doc = InstanceType<typeof Window>["document"];
type Site = "deep-locator" | "runner-up" | "rephrase";

/** Fills `#out` so the document hits the target visible-text length and serialized byte size. */
function shapeBody(d: Doc, textLen: number, bytes: number): void {
  const out = d.getElementById("out") as unknown as HappyDomElement;
  const hdrLen = (d.getElementById("hdr") as unknown as HappyDomElement).textContent.length;
  const btnLen = "Create Account".length;
  out.innerHTML = `<p data-pad="">${"t".repeat(Math.max(textLen - hdrLen - btnLen, 0))}</p>`;
  const deficit = bytes - d.documentElement.outerHTML.length;
  (out.firstElementChild as unknown as HappyDomElement).setAttribute(
    "data-pad",
    "x".repeat(Math.max(deficit, 0))
  );
}

interface World {
  page: Page;
  stagehand: Stagehand;
  counter: { n: number };
  act: ReturnType<typeof vi.fn>;
  rendered: () => boolean;
  clicks: () => number[];
}

/**
 * The step's first click (act-string, and its el.click() fallback) lands on a decoy, so it is a no-op. Only the site under
 * test issues a click that reaches the real control; when `advances` is false
 * that click is a no-op too.
 */
function buildWorld(site: Site, advances: boolean): World {
  const window = new Window({ url: URL });
  const document = window.document;
  document.body.innerHTML = `<div><h1 id="hdr">Sign In</h1><div id="out"></div><button id="theControl" type="button">Create Account</button><span id="decoy">x</span></div>`;
  shapeBody(document as unknown as Doc, PRE_TEXT_LEN, PRE_BYTES);
  const control = document.getElementById("theControl") as unknown as HappyDomElement;
  const hdr = document.getElementById("hdr") as unknown as HappyDomElement;
  const decoyXPath = xpathFor(document.getElementById("decoy") as unknown as HappyDomElement);

  let now = 0;
  let clickedAt: number | null = null;
  let rendered = false;
  const clicks: number[] = [];
  const counter = { n: 0 };
  (
    control as unknown as { addEventListener: (t: string, cb: () => void) => void }
  ).addEventListener("click", () => {
    if (!advances) return;
    clickedAt = now;
    hdr.textContent = "Signed in as jane@example.com";
  });

  let resolveRequest: (() => void) | null = null;
  let requestStarted = false;
  (window as unknown as { fetch: () => Promise<void> }).fetch = () =>
    new Promise<void>((res) => {
      resolveRequest = res;
    });

  const root = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (e: string) => { singleNodeValue: unknown } }).evaluate = (
    e: string
  ) => ({ singleNodeValue: e.startsWith("//") ? null : resolveXPath(root, e) });

  const realEvaluate = async (expr: unknown): Promise<unknown> =>
    (
      new window.Function("document", "XPathResult", `return (${String(expr)});`) as (
        d: unknown,
        x: unknown
      ) => unknown
    )(document, win.XPathResult);
  const clickControl = (): void => (control as unknown as { click: () => void }).click();

  const evaluate = async (expr: unknown): Promise<unknown> => {
    const src = String(expr);
    const isRank = src.includes("deepElements") && src.includes("ranked.sort");
    const isClick = src.includes("deepElements") && src.includes("clicked: true");
    if (site === "rephrase" && (isRank || isClick)) return isRank ? [] : { clicked: false };
    if (isRank) {
      const top = { deepIndex: 0, tier: 3, tag: "button", accessibleName: "Create Account" };
      return site === "runner-up"
        ? [top, { deepIndex: 1, tier: 2, tag: "div", accessibleName: "Create Account" }]
        : [top];
    }
    if (isClick) {
      const idx = src.includes("all[1]") ? 1 : 0;
      clicks.push(idx);
      if (idx === (site === "runner-up" ? 1 : 0)) clickControl();
      return { clicked: true };
    }
    return realEvaluate(expr);
  };

  const session = { on: () => {}, off: () => {} };
  const page = {
    evaluate,
    url: () => URL,
    title: async () => "Sign In",
    locator: () => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async (ms: number): Promise<void> => {
      now += ms;
      if (
        clickedAt !== null &&
        !requestStarted &&
        (window as unknown as { __settleQ?: unknown }).__settleQ
      ) {
        requestStarted = true;
        void (window as unknown as { fetch: () => Promise<void> }).fetch();
      }
      if (clickedAt !== null && !rendered && now - clickedAt >= RERENDER_DELAY_MS) {
        rendered = true;
        shapeBody(document as unknown as Doc, POST_TEXT_LEN, POST_BYTES);
        (resolveRequest as (() => void) | null)?.();
      }
    },
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;

  const act = vi.fn().mockImplementation(async (instruction: unknown) => {
    if (instruction === REPHRASED) clickControl();
    return {
      success: true,
      message: "clicked",
      actionDescription: "clicked",
      actions: [{ selector: `xpath=${decoyXPath}`, description: "control", method: "click" }],
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
  return { page, stagehand, counter, act, rendered: () => rendered, clicks: () => clicks };
}

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function params(world: World, rephrase: boolean): never {
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
    trajectory: [],
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: {},
    rephraseModel: rephrase ? ({ modelId: "test-model" } as unknown as RephraseModel) : null,
    logger: testLogger,
    uploadFixture: null,
    isFinalStep: false,
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

function logLines(): string[] {
  return vi
    .mocked(testLogger.info)
    .mock.calls.concat(vi.mocked(testLogger.warn).mock.calls)
    .map((c) => String(c[0]));
}

const GIVE_UP = /phantom-click-exhausted|replan/;

describe("flow-runner/executeStepWithHealing — mid-flow credit at bypass sites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateObjectMock.mockResolvedValue({
      object: { outcome: "rephrased", instruction: REPHRASED },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  });

  it("credits a late advance clicked by the deep-submit-locator", async () => {
    const world = buildWorld("deep-locator", true);

    const outcome = await executeStepWithHealing(params(world, false));
    expect(outcome).toBe("completed");
    expect(world.rendered()).toBe(true);
    expect(world.clicks()).toEqual([0]);
    expect(world.counter.n).toBe(0);
    expect(verifySubmitWithLLM).not.toHaveBeenCalled();
    expect(logLines().some((l) => GIVE_UP.test(l))).toBe(false);
  });

  it("credits a late advance clicked by the runner-up after the top pick phantomed", async () => {
    const world = buildWorld("runner-up", true);

    const outcome = await executeStepWithHealing(params(world, false));

    expect(outcome).toBe("completed");
    expect(world.rendered()).toBe(true);
    expect(world.clicks()).toEqual([0, 1]);
    expect(verifySubmitWithLLM).not.toHaveBeenCalled();
    expect(logLines().some((l) => GIVE_UP.test(l))).toBe(false);
  });

  it("credits a late advance clicked by the llm-rephrase attempt", async () => {
    const world = buildWorld("rephrase", true);

    const outcome = await executeStepWithHealing(params(world, true));

    expect(outcome).toBe("completed");
    expect(world.rendered()).toBe(true);
    expect(world.act.mock.calls.map((c) => c[0])).toContain(REPHRASED);
    expect(verifySubmitWithLLM).not.toHaveBeenCalled();
    expect(logLines().some((l) => GIVE_UP.test(l))).toBe(false);
  });

  it.each<Site>(["deep-locator", "runner-up", "rephrase"])(
    "still ends phantom when the %s click is a no-op",
    async (site) => {
      const world = buildWorld(site, false);

      const outcome = await executeStepWithHealing(params(world, site === "rephrase")).catch(
        () => "threw"
      );

      expect(outcome).not.toBe("completed");
      expect(world.rendered()).toBe(false);
    }
  );
});
