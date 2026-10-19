import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Primary-attempt matrix: a non-final submit-shaped click whose page advances
 * (header flip and/or body re-render at varying delays, no counted network, no
 * URL change, stale title) must be credited on attempt 1 from the settled
 * advance judgement alone; a genuine no-op keeps the give-up and the final
 * step stays strict.
 */

vi.mock("@/lib/llm/judges/verify-step-advanced", () => ({
  verifyStepAdvancedWithLLM: vi.fn(async () => ({ advanced: false, reason: "no change" })),
}));

vi.mock("@/lib/llm/judges/verify-submit", () => ({
  verifySubmitWithLLM: vi.fn(async () => ({
    verified: false,
    reason: "title unchanged and no network or url evidence",
  })),
}));

const VERBATIM_STEP =
  "On the account registration form (Email Address, Password and Verify New Password already filled), click the 'Create Account' button to submit the account creation form";
const URL = "https://example.org/signup";
const IDLE_GIVE_UP_MS = 14_000;
const STEP_PAUSE_MS = 2_000;
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

interface Timing {
  headerMs: number;
  bodyMs: number;
}

function buildWorld(title: string, timing: Timing): World {
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
  let headerDone = false;
  const state = { rendered: false };
  const counter = { n: 0 };
  const click = (): void => {
    clickedAt = now;
    applyDue();
  };
  const applyDue = (): void => {
    if (clickedAt === null) return;
    if (!headerDone && now - clickedAt >= timing.headerMs) {
      headerDone = true;
      hdr.textContent = "My Account";
    }
    if (!state.rendered && now - clickedAt >= timing.bodyMs) {
      state.rendered = true;
      out.innerHTML = `<p>${POST_TEXT}</p>`;
    }
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
      applyDue();
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
  step: string = VERBATIM_STEP,
  overrides: Record<string, unknown> = {}
): never {
  return {
    stagehand: world.stagehand,
    page: world.page,
    step,
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

const NEVER: Timing = { headerMs: 1e9, bodyMs: 1e9 };

const VARIANTS: { name: string; timing: Timing; step?: string }[] = [
  { name: "body re-renders 5s after header flip", timing: { headerMs: 0, bodyMs: 5000 } },
  { name: "body re-renders 8s after header flip", timing: { headerMs: 0, bodyMs: 8000 } },
  { name: "body re-renders 12s after header flip", timing: { headerMs: 0, bodyMs: 12_000 } },
  {
    name: "body re-renders 20s after header flip (beyond the old two-round budget)",
    timing: { headerMs: 0, bodyMs: 20_000 },
  },
  {
    name: "body re-renders 30s after header flip",
    timing: { headerMs: 0, bodyMs: 30_000 },
  },
  { name: "header and body land together", timing: { headerMs: 3000, bodyMs: 3000 } },
  { name: "header and body land immediately", timing: { headerMs: 0, bodyMs: 0 } },
  { name: "body lands first, header flips 6s later", timing: { headerMs: 6000, bodyMs: 0 } },
  {
    name: "differently worded non-final submit-shaped step",
    timing: { headerMs: 0, bodyMs: 8000 },
    step: "Press the 'Register' button to submit the sign-up form",
  },
];

describe("flow-runner/executeStepWithHealing — mid-flow submit credit timing matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(VARIANTS)("credits attempt 1: $name", async ({ timing, step }) => {
    const world = buildWorld("Sign In", timing);
    const trajectory: unknown[] = [];

    const outcome = await executeStepWithHealing(params(world, false, trajectory, step));

    expect(outcome).toBe("completed");
    expect(world.state.rendered).toBe(true);
    expect(world.counter.n).toBe(0);
    expect(world.act).toHaveBeenCalledTimes(1);
    expect(trajectory).toHaveLength(1);
    expect(logs().some((l) => /phantom-click-exhausted|replan/i.test(l))).toBe(false);
  });

  it("gives up a genuine no-op click on the idle timeline and classifies it phantom", async () => {
    const world = buildWorld("Sign In", NEVER);
    world.act.mockImplementation(async () => ({
      success: true,
      message: "clicked",
      actionDescription: "clicked",
      actions: [],
    }));
    const trajectory: unknown[] = [];

    const outcome = await executeStepWithHealing(params(world, false, trajectory)).catch(
      () => "threw"
    );

    expect(outcome).not.toBe("completed");
    expect(world.state.rendered).toBe(false);
    expect(trajectory).toHaveLength(0);
    expect(world.clock()).toBeGreaterThanOrEqual(STEP_PAUSE_MS + IDLE_GIVE_UP_MS);
    expect(logs().some((l) => /phantom/i.test(l))).toBe(true);
  });

  it("keeps demanding network/URL proof for the final-position submit", async () => {
    const world = buildWorld("Sign In", { headerMs: 0, bodyMs: 8000 });

    const outcome = await executeStepWithHealing(params(world, true, [])).catch(() => "threw");

    expect(outcome).not.toBe("completed");
  });

  it.each([
    ["omitted", undefined],
    ["unset by a caller that never derived it", null],
  ])(
    "keeps the flagged final submit strict when the flow-level flag is %s",
    async (_label, flag) => {
      const world = buildWorld("Sign In", { headerMs: 0, bodyMs: 8000 });

      const outcome = await executeStepWithHealing(
        params(world, true, [], VERBATIM_STEP, { flowHasSubmitSemantics: flag })
      ).catch(() => "threw");

      expect(outcome).not.toBe("completed");
    }
  );
});
