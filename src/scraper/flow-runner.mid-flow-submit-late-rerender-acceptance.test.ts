import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifySubmitWithLLM } from "@/lib/llm/judges/verify-submit";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Acceptance contract for a mid-flow submit-shaped step: credited once the page
 * demonstrably advances (immediate header flip then late body re-render, or
 * text growth under a different stale title), never credited for a genuine
 * no-op click, and held to final-submit evidence standards on the final step.
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

interface Scenario {
  title: string;
  hdrBefore: string;
  hdrAfter: string | null;
  initialBody: (d: Doc) => void;
  rerender: ((d: Doc) => void) | null;
  rerenderDelayMs: number;
  uncountedRequest?: boolean;
}

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

const REPORT: Scenario = {
  title: "Sign In",
  hdrBefore: "Sign In",
  hdrAfter: "Signed in as jane@example.com",
  initialBody: (d) => shapeBody(d, PRE_TEXT_LEN, PRE_BYTES),
  rerender: (d) => shapeBody(d, POST_TEXT_LEN, POST_BYTES),
  rerenderDelayMs: RERENDER_DELAY_MS,
};

const LATE: Scenario = { ...REPORT, rerenderDelayMs: 12000, uncountedRequest: true };

const GROWTH: Scenario = {
  title: "Join",
  hdrBefore: "Join",
  hdrAfter: "Verify",
  initialBody: (d) => {
    (d.getElementById("out") as unknown as HappyDomElement).innerHTML = "<p>Short</p>";
  },
  rerender: (d) => {
    (d.getElementById("out") as unknown as HappyDomElement).innerHTML =
      `<p>${"Check your inbox for the code we sent. ".repeat(10)}</p>`;
  },
  rerenderDelayMs: 4000,
};

const LONG_NAV = `<nav>${"Home Jobs Careers Benefits Locations Teams Students Veterans Events Blog Press Contact Help FAQ Privacy Terms. ".repeat(3)}</nav>`;

/** Body swaps entirely beyond the 200-char signature head, under long unchanged chrome. */
const BELOW_HEAD: Scenario = {
  title: "Sign In",
  hdrBefore: "Sign In",
  hdrAfter: null,
  initialBody: (d) => {
    (d.getElementById("out") as unknown as HappyDomElement).innerHTML =
      `${LONG_NAV}<p>${"Email Password Verify Password Terms. ".repeat(10)}</p>`;
  },
  rerender: (d) => {
    (d.getElementById("out") as unknown as HappyDomElement).innerHTML =
      `${LONG_NAV}<p>${"Welcome aboard check inbox confirm address. ".repeat(9)}</p>`;
  },
  rerenderDelayMs: 3000,
};

const NOOP: Scenario = {
  title: "Sign In",
  hdrBefore: "Sign In",
  hdrAfter: null,
  initialBody: (d) => shapeBody(d, PRE_TEXT_LEN, PRE_BYTES),
  rerender: null,
  rerenderDelayMs: 0,
};

interface World {
  page: Page;
  stagehand: Stagehand;
  counter: { n: number };
  act: ReturnType<typeof vi.fn>;
  rendered: () => boolean;
  preMetrics: { text: number; bytes: number };
  postMetrics: () => { text: number; bytes: number };
}

function buildWorld(sc: Scenario, actions: "click" | "none" = "click"): World {
  const window = new Window({ url: URL });
  const document = window.document;
  document.body.innerHTML = `<div><h1 id="hdr">${sc.hdrBefore}</h1><div id="out"></div><button id="theControl" type="button">Create Account</button></div>`;
  sc.initialBody(document as unknown as Doc);
  const control = document.getElementById("theControl") as unknown as HappyDomElement;
  const hdr = document.getElementById("hdr") as unknown as HappyDomElement;
  const controlXPath = xpathFor(control);
  const metrics = (): { text: number; bytes: number } => ({
    text: document.body.textContent.length,
    bytes: document.documentElement.outerHTML.length,
  });
  const preMetrics = metrics();

  let now = 0;
  let clickedAt: number | null = null;
  let rendered = false;
  const counter = { n: 0 };
  (
    control as unknown as { addEventListener: (t: string, cb: () => void) => void }
  ).addEventListener("click", () => {
    clickedAt = now;
    if (sc.hdrAfter !== null) hdr.textContent = sc.hdrAfter;
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
    title: async () => sc.title,
    locator: () => ({
      first: () => ({
        click: async () => (control as unknown as { click: () => void }).click(),
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async (ms: number): Promise<void> => {
      now += ms;
      if (
        sc.uncountedRequest &&
        clickedAt !== null &&
        !requestStarted &&
        (window as unknown as { __settleQ?: unknown }).__settleQ
      ) {
        requestStarted = true;
        void (window as unknown as { fetch: () => Promise<void> }).fetch();
      }
      if (sc.rerender && clickedAt !== null && !rendered && now - clickedAt >= sc.rerenderDelayMs) {
        rendered = true;
        sc.rerender(document as unknown as Doc);
        (resolveRequest as (() => void) | null)?.();
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
      actions:
        actions === "none"
          ? []
          : [{ selector: `xpath=${controlXPath}`, description: "control", method: "click" }],
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
  return {
    page,
    stagehand,
    counter,
    act,
    rendered: () => rendered,
    preMetrics,
    postMetrics: metrics,
  };
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
  step: string = STEP
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
    submitEndpointPattern: null,
    submittedStateSelectors: [],
    requireSubmitEndpointMatch: false,
    flowHasSubmitSemantics: true,
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

describe("flow-runner/executeStepWithHealing — mid-flow credit contract acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifySubmitWithLLM).mockResolvedValue({
      verified: false,
      reason: "no network or url evidence",
    } as never);
  });

  it("report signatures: 996→588 text, 31284→29300 bytes, no network", () => {
    const world = buildWorld(REPORT);
    expect(world.preMetrics.text).toBe(PRE_TEXT_LEN);
    expect(world.preMetrics.bytes).toBe(PRE_BYTES);
  });

  it("credits the late re-render with no phantom verdict and no replan", async () => {
    const world = buildWorld(REPORT);

    const outcome = await executeStepWithHealing(params(world, false, []));

    expect(world.rendered()).toBe(true);
    expect(world.postMetrics()).toEqual({ text: POST_TEXT_LEN, bytes: POST_BYTES });
    expect(outcome).toBe("completed");
    expect(world.counter.n).toBe(0);
    expect(world.act).toHaveBeenCalledTimes(1);
    expect(world.act.mock.calls[0]?.[0]).toBe(STEP);
    expect(verifySubmitWithLLM).not.toHaveBeenCalled();
    expect(logLines().some((l) => /phantom|deep-submit-locator|llm-rephrase|replan/.test(l))).toBe(
      false
    );
  });

  it("credits a re-render landing beyond the old quiet window with no network", async () => {
    const world = buildWorld(LATE);

    const outcome = await executeStepWithHealing(params(world, false, []));

    expect(world.rendered()).toBe(true);
    expect(world.postMetrics()).toEqual({ text: POST_TEXT_LEN, bytes: POST_BYTES });
    expect(outcome).toBe("completed");
    expect(world.counter.n).toBe(0);
    expect(world.act).toHaveBeenCalledTimes(1);
    expect(verifySubmitWithLLM).not.toHaveBeenCalled();
    expect(logLines().some((l) => /phantom|deep-submit-locator|llm-rephrase|replan/.test(l))).toBe(
      false
    );
  });

  it.each([2000, 3000, 8000, 11000])(
    "credits a header flip followed by a body re-render %ims later with no network",
    async (delay) => {
      const world = buildWorld({ ...REPORT, rerenderDelayMs: delay });

      const outcome = await executeStepWithHealing(params(world, false, []));

      expect(world.rendered()).toBe(true);
      expect(outcome).toBe("completed");
      expect(world.counter.n).toBe(0);
      expect(world.act).toHaveBeenCalledTimes(1);
      expect(verifySubmitWithLLM).not.toHaveBeenCalled();
      expect(
        logLines().some((l) => /phantom|deep-submit-locator|llm-rephrase|replan/.test(l))
      ).toBe(false);
    }
  );

  it.each([2000, 11000])(
    "credits a re-render to longer text %ims after the flip",
    async (delay) => {
      const world = buildWorld({
        ...GROWTH,
        title: "Sign In",
        rerenderDelayMs: delay,
      });

      const outcome = await executeStepWithHealing(params(world, false, []));

      expect(world.rendered()).toBe(true);
      expect(outcome).toBe("completed");
      expect(world.act).toHaveBeenCalledTimes(1);
      expect(verifySubmitWithLLM).not.toHaveBeenCalled();
    }
  );

  it("credits a differently worded submit step on a different advancing page", async () => {
    const world = buildWorld({ ...GROWTH, hdrBefore: "Subscribe", hdrAfter: "Confirm" });

    const outcome = await executeStepWithHealing(
      params(world, false, [], "Press the 'Create Account' control to send the subscription form")
    );

    expect(world.rendered()).toBe(true);
    expect(outcome).toBe("completed");
    expect(verifySubmitWithLLM).not.toHaveBeenCalled();
  });

  it.each(["Sign In", "Welcome"])(
    "credits the late re-render with document title %s",
    async (title) => {
      const world = buildWorld({ ...REPORT, title, rerenderDelayMs: 11000 });

      const outcome = await executeStepWithHealing(params(world, false, []));

      expect(outcome).toBe("completed");
      expect(verifySubmitWithLLM).not.toHaveBeenCalled();
    }
  );

  it("does not credit the late re-render on the final step", async () => {
    const world = buildWorld(LATE);

    const outcome = await executeStepWithHealing(params(world, true, [])).catch(() => "threw");

    expect(outcome).not.toBe("completed");
  });

  it("keeps the give-up for a genuine no-op click", async () => {
    const world = buildWorld(NOOP);

    const outcome = await executeStepWithHealing(params(world, false, [])).catch(() => "threw");

    expect(outcome).not.toBe("completed");
    expect(world.rendered()).toBe(false);
  });

  it("credits a text-growth transition under a different stale title", async () => {
    const world = buildWorld(GROWTH);

    const outcome = await executeStepWithHealing(params(world, false, []));

    expect(world.rendered()).toBe(true);
    expect(outcome).toBe("completed");
    expect(world.act).toHaveBeenCalledTimes(1);
    expect(verifySubmitWithLLM).not.toHaveBeenCalled();
  });

  it("credits a body that re-renders past the signature head with the header and length unchanged", async () => {
    const world = buildWorld(BELOW_HEAD);

    const outcome = await executeStepWithHealing(params(world, false, []));

    expect(world.rendered()).toBe(true);
    expect(outcome).toBe("completed");
    expect(world.act).toHaveBeenCalledTimes(1);
    expect(verifySubmitWithLLM).not.toHaveBeenCalled();
  });

  it("does not credit the same below-head re-render on the final step", async () => {
    const world = buildWorld(BELOW_HEAD);

    const outcome = await executeStepWithHealing(params(world, true, [])).catch(() => "threw");

    expect(outcome).not.toBe("completed");
  });

  it("credits the advance when Stagehand reports success with no resolved action", async () => {
    const world = buildWorld(REPORT, "none");

    const outcome = await executeStepWithHealing(params(world, false, []));

    expect(outcome).toBe("completed");
    expect(world.act).toHaveBeenCalledTimes(1);
    expect(logLines().some((l) => /phantom|deep-submit-locator|llm-rephrase|replan/.test(l))).toBe(
      false
    );
  });

  it("does not credit the same DOM-only advance on the final step", async () => {
    const world = buildWorld(REPORT);

    const outcome = await executeStepWithHealing(params(world, true, [])).catch(() => "threw");

    expect(outcome).not.toBe("completed");
  });
});
