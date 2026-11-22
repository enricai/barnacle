import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerCentreHitTest } from "@/scraper/centre-hit-test-fake.test-helper";
import { StepVerificationError } from "@/scraper/errors";
import {
  type AttemptRecord,
  describeAttemptEffectSignals,
  executeStepWithHealing,
  snapshotPage,
} from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Acceptance: a cookie-consent banner dismissal (neutral example domain) is
 * credited as a view-swap on attempt 1, not vetoed as a page reset; a reset
 * with no visible-text shrink stays vetoed.
 */

const guardedObserve = vi.fn();
const guardedAct = vi.fn();

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
    guardedAct: (...args: unknown[]) => guardedAct(...args),
  };
});

const SILENT_LOGGER_CALLS = { info: [] as string[], warn: [] as string[] };
const testLogger = {
  info: vi.fn((msg: string) => SILENT_LOGGER_CALLS.info.push(msg)),
  warn: vi.fn((msg: string) => SILENT_LOGGER_CALLS.warn.push(msg)),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** Mirrors Stagehand's `nodeToAbsoluteXPath`: pure tag+sibling-position steps. */
function absoluteXPathFor(el: HappyDomElement): string {
  const steps: string[] = [];
  let node: HappyDomElement | null = el;
  while (node) {
    const currentNode: HappyDomElement = node;
    const parent: HappyDomElement | null = currentNode.parentElement;
    if (!parent) {
      steps.unshift(`${currentNode.tagName.toLowerCase()}[1]`);
      break;
    }
    const sameTag = Array.from(parent.children).filter(
      (c: HappyDomElement) => c.tagName === currentNode.tagName
    );
    const idx = sameTag.indexOf(currentNode) + 1;
    steps.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
    node = parent;
  }
  return `/${steps.join("/")}`;
}

function resolveAbsoluteXPath(root: HappyDomElement, xp: string): HappyDomElement | null {
  const steps = xp
    .split("/")
    .filter(Boolean)
    .map((step) => {
      const match = /^([a-zA-Z0-9]+)\[(\d+)\]$/.exec(step);
      if (!match) throw new Error(`unsupported xpath step in test fixture: ${step}`);
      return { tag: match[1]?.toUpperCase(), idx: Number(match[2]) };
    });
  let current: HappyDomElement | null = root;
  for (const step of steps.slice(1)) {
    if (!current) return null;
    const candidates: HappyDomElement[] = Array.from(current.children).filter(
      (c: HappyDomElement) => c.tagName === step.tag
    );
    current = candidates[step.idx - 1] ?? null;
  }
  return current;
}

const BASE_URL = "https://news.example.com/article";
const STEP_INSTRUCTION =
  "If a cookie consent banner is shown, click 'Accept' or 'Agree' to dismiss it";
const BANNER_TEXT = "We use cookies to personalise content and measure traffic. ".repeat(10);

type Harness = {
  call: Promise<unknown>;
  trajectory: { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"] }[];
  pre: Awaited<ReturnType<typeof snapshotPage>>;
  post: () => Promise<Awaited<ReturnType<typeof snapshotPage>>>;
  frameTarget: FrameTarget;
  clicks: () => number;
};

/**
 * Builds a live happy-dom page whose "Accept" button, on click, swaps the body
 * for `afterHtml`. Every production evaluate runs for real against that DOM.
 */
async function buildHarness(beforeHtml: string, afterHtml: string): Promise<Harness> {
  const window = new Window({ url: BASE_URL });
  const document = window.document;
  document.body.innerHTML = beforeHtml;
  const buttonEl = document.getElementById("acceptBtn") as unknown as HappyDomElement;
  const buttonXPath = absoluteXPathFor(buttonEl);
  let clickCount = 0;
  (
    buttonEl as unknown as { addEventListener: (t: string, cb: () => void) => void }
  ).addEventListener("click", () => {
    clickCount += 1;
    document.body.innerHTML = afterHtml;
  });
  const documentElement = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate = (
    expr: string
  ) => ({
    singleNodeValue: expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr),
  });
  const evaluateImpl = async (expr: unknown): Promise<unknown> => {
    const centred = answerCentreHitTest(expr);
    if (centred) return centred;
    const fn = new window.Function("document", "XPathResult", `return (${String(expr)});`) as (
      d: unknown,
      x: unknown
    ) => unknown;
    return fn(document, win.XPathResult);
  };
  const locator = () => ({
    first: () => ({ isChecked: async () => false, inputValue: async () => "" }),
  });
  const frameTarget = {
    frame: undefined,
    frameSelector: undefined,
    evaluate: evaluateImpl,
    locator,
    url: () => Promise.resolve(BASE_URL),
    title: () => Promise.resolve("Article"),
  } as unknown as FrameTarget;
  const session = { on: () => {}, off: () => {} };
  const page = {
    evaluate: evaluateImpl,
    url: () => BASE_URL,
    title: async () => "Article",
    locator,
    waitForTimeout: async () => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;

  const pre = await snapshotPage(frameTarget, { n: 0 });

  const action = {
    selector: `xpath=${buttonXPath}`,
    description: "Accept button",
    method: "click",
  };
  guardedAct.mockImplementation(async () => {
    (
      resolveAbsoluteXPath(documentElement, buttonXPath) as unknown as { click?: () => void } | null
    )?.click?.();
    return {
      success: true,
      message: "clicked",
      actionDescription: STEP_INSTRUCTION,
      actions: [action],
    };
  });
  guardedObserve.mockResolvedValue([action]);

  const trajectory: Harness["trajectory"] = [];
  const call = executeStepWithHealing({
    stagehand: {} as unknown as Stagehand,
    page,
    frameTarget,
    step: STEP_INSTRUCTION,
    optional: false,
    upload: false,
    submitStep: false,
    flowHasSubmitSemantics: false,
    stepIndex: 0,
    totalSteps: () => 3,
    phase: "flow",
    signalCounter: { n: 0 },
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: null,
    rephraseModel: null,
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
    trajectory,
    onStepFailure: () => null,
  });
  return {
    call,
    trajectory,
    pre,
    post: () => snapshotPage(frameTarget, { n: 0 }),
    frameTarget,
    clicks: () => clickCount,
  };
}

describe("flow-runner banner dismissal is credited as a view-swap (offline fixture, live happy-dom, no network)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    SILENT_LOGGER_CALLS.info.length = 0;
    SILENT_LOGGER_CALLS.warn.length = 0;
  });

  it("credits a consent-banner dismissal (target removed, ~560 chars of text and >1.6KB of HTML gone) on attempt 1 as view-swap, and does not describe it as a reflow", async () => {
    const h = await buildHarness(
      `<main><h1>Headlines</h1><p>Top story.</p>
        <div class="consentBanner" data-layout="${"x".repeat(1000)}">
          <p>${BANNER_TEXT}</p>
          <button id="acceptBtn">Accept</button>
        </div></main>`,
      `<main><h1>Headlines</h1><p>Top story.</p></main>`
    );
    await h.call;
    expect(h.clicks()).toBe(1);
    expect(h.trajectory).toEqual([{ stepIndex: 0, verifiedBy: "view-swap" }]);
    expect(SILENT_LOGGER_CALLS.info.join("\n")).toContain("succeeded on attempt 1");

    const post = await h.post();
    const textDrop = h.pre.visibleTextSignature.split(":")[0];
    expect(Number(textDrop) - Number(post.visibleTextSignature.split(":")[0])).toBeGreaterThan(500);
    expect(h.pre.bodyHtmlLength - post.bodyHtmlLength).toBeGreaterThan(1500);

    const signals = describeAttemptEffectSignals(h.pre, post, [], 0);
    expect(signals).toContain("content-removed");
    expect(signals).not.toContain("reflowed slightly");
  });

  it("still vetoes a reset that removes the target with no visible-text change", async () => {
    const h = await buildHarness(
      `<main data-pad="${"x".repeat(12_000)}"><h1>Headlines</h1><button id="acceptBtn" aria-label="Accept"></button></main>`,
      `<main><h1>Headlines</h1></main>`
    );
    await expect(h.call).rejects.toBeInstanceOf(StepVerificationError);
    expect(h.trajectory.some((t) => t.verifiedBy === "view-swap")).toBe(false);
    expect(SILENT_LOGGER_CALLS.info.some((l) => l.includes("n+16 probe"))).toBe(true);
  });
});
