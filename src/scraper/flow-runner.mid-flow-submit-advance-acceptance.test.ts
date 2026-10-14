import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Combined acceptance for a store checkout's non-final "Place Order" click:
 * a header flip plus a ~8s-late body re-render with no counted network is
 * credited, a genuine no-op click keeps the full settle give-up and the
 * phantom verdict, and the judge sees the step context (non-final accepted,
 * final rejection honoured).
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
const RERENDER_DELAY_MS = 8000;
const RERENDERED_TEXT = "Thanks for your purchase, check your email for the receipt";

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
  waits: number[];
  page: Page;
  stagehand: Stagehand;
  state: { rendered: boolean };
  counter: { n: number };
  act: ReturnType<typeof vi.fn>;
}

function buildWorld(title: string, noop = false): World {
  const window = new Window({ url: URL });
  const document = window.document;
  document.body.innerHTML = `
    <div><h1 id="hdr">Checkout</h1>
    <form id="theForm"><button id="theControl" type="submit">Place Order</button></form>
    <div id="out"><p>Review your order</p></div></div>`;
  const control = document.getElementById("theControl") as unknown as HappyDomElement;
  const hdr = document.getElementById("hdr") as unknown as HappyDomElement;
  const out = document.getElementById("out") as unknown as HappyDomElement;
  const controlXPath = xpathFor(control);

  const waits: number[] = [];
  let now = 0;
  let clickedAt: number | null = null;
  const state = { rendered: false };
  const counter = { n: 0 };
  const click = (): void => {
    if (noop) return;
    clickedAt = now;
    hdr.textContent = "Placing your order";
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
      waits.push(ms);
      if (clickedAt !== null && !state.rendered && now - clickedAt >= RERENDER_DELAY_MS) {
        state.rendered = true;
        hdr.textContent = "Order placed";
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
  return { page, stagehand, state, counter, act, waits };
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

function logsOf(): string[] {
  return vi
    .mocked(testLogger.info)
    .mock.calls.concat(vi.mocked(testLogger.warn).mock.calls)
    .map((c) => String(c[0]));
}

describe("flow-runner mid-flow submit acceptance (store checkout)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifySubmitWithLLM).mockResolvedValue({
      verified: true,
      reason: "order confirmation view visible",
    } as never);
  });

  it("credits a non-final click whose body re-renders ~8s late with no network, not as phantom", async () => {
    const world = buildWorld("Checkout");

    const outcome = await executeStepWithHealing(params(world, false, []));

    expect(world.state.rendered).toBe(true);
    expect(outcome).toBe("completed");
    expect(world.counter.n).toBe(0);
    expect(world.act).toHaveBeenCalledTimes(1);
    const logs = logsOf();
    expect(logs.some((l) => l.includes("phantom-click-exhausted"))).toBe(false);
    expect(logs.some((l) => /deep-submit-locator|llm-rephrase/.test(l))).toBe(false);
  });

  it("keeps the 14-poll give-up, the phantom verdict and escalation for a genuine no-op click", async () => {
    vi.mocked(verifySubmitWithLLM).mockResolvedValue({
      verified: false,
      reason: "nothing changed",
    } as never);
    const world = buildWorld("Checkout", true);

    const outcome = await executeStepWithHealing(params(world, false, [])).catch(() => "threw");

    expect(outcome).not.toBe("completed");
    expect(world.state.rendered).toBe(false);
    const firstSettle = world.waits.slice(
      1,
      world.waits.findIndex((ms, i) => i > 0 && ms !== 1000)
    );
    expect(firstSettle).toHaveLength(14);
    const logs = logsOf();
    expect(logs.some((l) => /phantom/.test(l))).toBe(true);
    expect(logs.some((l) => /deep-submit-locator|llm-rephrase/.test(l))).toBe(true);
  });

  it("gives the judge instruction, isFinalStep=false and visible text for a stale-title non-final step, and accepts verified=true", async () => {
    const world = buildWorld("Cart");

    const outcome = await executeStepWithHealing(params(world, false, [], "/orders"));

    expect(outcome).toBe("completed");
    const calls = vi.mocked(verifySubmitWithLLM).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [arg] of calls) {
      expect(arg.input.pageTitle).toBe("Cart");
      expect(arg.input.isFinalStep).toBe(false);
      expect(arg.input.stepInstruction).toBe(STEP);
      expect(arg.input.visibleText).toContain(RERENDERED_TEXT);
    }
  });

  it("passes isFinalStep=true for the final step and still honours a rejection", async () => {
    vi.mocked(verifySubmitWithLLM).mockResolvedValue({
      verified: false,
      reason: "no network or url evidence",
    } as never);
    const world = buildWorld("Cart");

    const outcome = await executeStepWithHealing(params(world, true, [], "/orders")).catch(
      () => "threw"
    );

    expect(outcome).not.toBe("completed");
    const calls = vi.mocked(verifySubmitWithLLM).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [arg] of calls) expect(arg.input.isFinalStep).toBe(true);
  });
});
