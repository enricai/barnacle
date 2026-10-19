import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyStepAdvancedWithLLM } from "@/lib/llm/judges/verify-step-advanced";
import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { executeStepWithHealing, isMidFlowAdvanceCredited } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * A submit-worded last slot of a flow with no submit semantics is mid-flow: it
 * is judged by the step judge on settled before/after text and credited on a
 * demonstrable advance (or an unavailable judge), while a genuine final submit
 * keeps the strict submit judge.
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
    counter.n += 1;
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
    flowHasSubmitSemantics: false,
    submitEndpointPattern: "/api/submit",
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

describe("flow-runner/executeStepWithHealing — last slot without submit semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifySubmitWithLLM).mockResolvedValue({
      verified: false,
      reason: "no network or url evidence",
    } as never);
  });

  function lastSlot(world: World, flowSubmit: boolean, pattern: string | null): never {
    return {
      ...(params(world, true, [], SUBMIT_STEP, false) as object),
      flowHasSubmitSemantics: flowSubmit,
      submitEndpointPattern: pattern,
    } as never;
  }

  it.each([null, "/api/submit"])(
    "credits via the step judge when it says advanced (endpoint pattern %s)",
    async (pattern) => {
      vi.mocked(verifyStepAdvancedWithLLM).mockResolvedValue({
        advanced: true,
        reason: "account view",
      } as never);

      const outcome = await executeStepWithHealing(
        lastSlot(buildWorld("Sign In", 0), false, pattern)
      );

      expect(outcome).toBe("completed");
      expect(verifySubmitWithLLM).not.toHaveBeenCalled();
      const input = vi.mocked(verifyStepAdvancedWithLLM).mock.calls[0]?.[0].input;
      expect(input?.beforeText).toContain("Sign In");
      expect(input?.afterText).toContain("My Account");
    }
  );

  it.each([null, { advanced: false, reason: "no change" }])(
    "credits a demonstrable advance with a stale title when the step verdict is %j",
    async (verdict) => {
      vi.mocked(verifyStepAdvancedWithLLM).mockResolvedValue(verdict as never);

      const outcome = await executeStepWithHealing(
        lastSlot(buildWorld("Sign In", 0), false, "/api/submit")
      );

      expect(outcome).toBe("completed");
      expect(verifySubmitWithLLM).not.toHaveBeenCalled();
    }
  );

  it("keeps a genuine final submit on the strict submit judge", async () => {
    const outcome = await executeStepWithHealing(
      params(buildWorld("Sign In", 0), true, [], SUBMIT_STEP, true)
    ).catch(() => "threw");

    expect(outcome).toBe("threw");
    expect(verifySubmitWithLLM).toHaveBeenCalled();
    expect(verifyStepAdvancedWithLLM).not.toHaveBeenCalled();
  });
});

describe("flow-runner/isMidFlowAdvanceCredited", () => {
  const base = {
    midFlowSubmit: true,
    signalAdvanced: false,
    judgeUnavailable: false,
    networkAdvanced: false,
    pageAdvanced: false,
    invalidMarkerCount: 0,
  };

  it("credits a mid-flow step on its own advance signal despite a judge rejection", () => {
    expect(isMidFlowAdvanceCredited({ ...base, signalAdvanced: true })).toBe(true);
  });

  it("credits an unavailable judge only on a demonstrable advance", () => {
    expect(isMidFlowAdvanceCredited({ ...base, judgeUnavailable: true })).toBe(false);
    expect(isMidFlowAdvanceCredited({ ...base, judgeUnavailable: true, pageAdvanced: true })).toBe(
      true
    );
  });

  it("never credits a genuine final submit", () => {
    expect(
      isMidFlowAdvanceCredited({
        ...base,
        midFlowSubmit: false,
        signalAdvanced: true,
        judgeUnavailable: true,
        pageAdvanced: true,
      })
    ).toBe(false);
  });
});
