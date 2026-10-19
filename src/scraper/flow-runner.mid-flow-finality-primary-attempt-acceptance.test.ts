import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifyStepAdvancedWithLLM } from "@/lib/llm/judges/verify-step-advanced";
import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Report regression: in the last slot of a flow without submit semantics, a
 * submit-shaped click (account creation) whose header flips at once but whose
 * main body re-renders ~8s later with no counted network must be credited, not
 * phantom and not submit-judge-rejected, even though the judge sees the stale
 * document title. The same shape as the real final submit stays rejected.
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
  page: Page;
  stagehand: Stagehand;
  state: { rendered: boolean };
  counter: { n: number };
  act: ReturnType<typeof vi.fn>;
  clock: () => number;
}

interface WorldOptions {
  advances?: boolean;
  viaFallback?: boolean;
}

function buildWorld(title: string, opts: WorldOptions = {}): World {
  const advances = opts.advances ?? true;
  const viaFallback = opts.viaFallback ?? false;
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
    if (!advances) return;
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
        click: async () => {
          if (!viaFallback) (control as unknown as { click: () => void }).click();
        },
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
    if (!viaFallback) (control as unknown as { click: () => void }).click();
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

function params(world: World, flowHasSubmitSemantics: boolean, trajectory: unknown[]): never {
  return {
    stagehand: world.stagehand,
    page: world.page,
    step: STEP,
    optional: false,
    upload: false,
    submitStep: flowHasSubmitSemantics,
    stepIndex: 0,
    totalSteps: () => 1,
    phase: "flow",
    signalCounter: world.counter,
    trajectory,
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: {},
    rephraseModel: null,
    logger: testLogger,
    uploadFixture: null,
    isFinalStep: true,
    flowHasSubmitSemantics,
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

const STALE_VERDICT = {
  verified: false,
  reason: "page title still reads Sign In, no network or url evidence",
} as never;

describe("flow-runner/executeStepWithHealing — last slot without submit semantics, late body re-render", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("credits the step after the settle even though the judge sees the stale title", async () => {
    vi.mocked(verifySubmitWithLLM).mockResolvedValue(STALE_VERDICT);
    const world = buildWorld("Sign In");
    const trajectory: unknown[] = [];

    const outcome = await executeStepWithHealing(params(world, false, trajectory));

    expect(outcome).toBe("completed");
    expect(world.state.rendered).toBe(true);
    expect(world.counter.n).toBe(0);
    expect(world.act).toHaveBeenCalledTimes(1);
    expect(trajectory).toHaveLength(1);
    expect(
      logs().some((l) => /submit-judge-rejected|phantom-click-exhausted|replan/i.test(l))
    ).toBe(false);
  });

  it("keeps strict rejection for the final step with submit semantics", async () => {
    vi.mocked(verifySubmitWithLLM).mockResolvedValue(STALE_VERDICT);
    const world = buildWorld("Sign In");

    const outcome = await executeStepWithHealing(params(world, true, [])).catch(
      (e: unknown) => `threw: ${String(e)}`
    );

    expect(String(outcome)).toMatch(/^threw: StepVerificationError.*failed verification/);
    expect(outcome).not.toBe("completed");
  });

  describe("step judge routing", () => {
    const stepJudge = vi.mocked(verifyStepAdvancedWithLLM);

    it("credits a submit-worded last slot with no submit semantics when the step judge says advanced", async () => {
      vi.mocked(verifySubmitWithLLM).mockResolvedValue(STALE_VERDICT);
      stepJudge.mockResolvedValue({ advanced: true, reason: "new page" });
      const world = buildWorld("Sign In");

      const outcome = await executeStepWithHealing(params(world, false, []));

      expect(outcome).toBe("completed");
      expect(stepJudge).toHaveBeenCalled();
      expect(verifySubmitWithLLM).not.toHaveBeenCalled();
    });

    it("credits that slot on a null step verdict with a demonstrable advance and a stale title", async () => {
      vi.mocked(verifySubmitWithLLM).mockResolvedValue(STALE_VERDICT);
      stepJudge.mockResolvedValue(null as never);
      const world = buildWorld("Sign In");

      const outcome = await executeStepWithHealing(params(world, false, []));

      expect(outcome).toBe("completed");
      expect(world.state.rendered).toBe(true);
      expect(verifySubmitWithLLM).not.toHaveBeenCalled();
    });

    it("credits that slot in the el.click() fallback path", async () => {
      vi.mocked(verifySubmitWithLLM).mockResolvedValue(STALE_VERDICT);
      stepJudge.mockResolvedValue({ advanced: true, reason: "new page" });
      const world = buildWorld("Sign In", { viaFallback: true });

      const outcome = await executeStepWithHealing(params(world, false, []));

      expect(outcome).toBe("completed");
      expect(world.state.rendered).toBe(true);
      expect(logs().some((l) => l.includes("n+16"))).toBe(true);
    });

    it("a genuine final submit still goes to the strict submit judge and never the step judge", async () => {
      vi.mocked(verifySubmitWithLLM).mockResolvedValue(STALE_VERDICT);
      stepJudge.mockResolvedValue({ advanced: true, reason: "new page" });
      const world = buildWorld("Sign In");

      await executeStepWithHealing(params(world, true, [])).catch(() => "threw");

      expect(verifySubmitWithLLM).toHaveBeenCalled();
      expect(stepJudge).not.toHaveBeenCalled();
    });

    it("a non-final step whose page did not advance is not credited", async () => {
      stepJudge.mockResolvedValue({ advanced: false, reason: "no change" });
      const world = buildWorld("Sign In", { advances: false });

      const outcome = await executeStepWithHealing(params(world, false, [])).catch(
        () => "threw"
      );

      expect(outcome).not.toBe("completed");
      expect(world.state.rendered).toBe(false);
    });
  });
});
