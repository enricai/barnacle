import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/** n+16 fallback select-step committed-value readback guard (offline happy-dom). */
const BASE_URL = "https://apply.example.com/application/experience";
const CONTINUE_STEP = "Select 'Alpha' for the Industry field";

function makeLogger(lines: string[]): Logger {
  return {
    info: vi.fn((m: string) => lines.push(m)),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

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

function buildHarness(commitValue: boolean) {
  const window = new Window({ url: BASE_URL });
  const document = window.document;
  document.body.innerHTML = `
    <div class="applicationFooter">
      <a id="continueLink" href="#">Go to education</a>
    </div>
  `;

  const continueEl = document.getElementById("continueLink") as unknown as HappyDomElement;
  expect(continueEl).not.toBeNull();
  const continueXPath = absoluteXPathFor(continueEl);

  let clickActivations = 0;
  const currentUrl = BASE_URL;
  const currentTitle = "Experience";
  (
    continueEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    clickActivations += 1;
    // A genuine (but small, sub-500B) DOM growth plus a visible-text change —
    // the weak-signal shape the disjunct under test exists to credit — paired
    // with a real navigation so the destination-plausibility gate has
    // something to veto.
    document.body.innerHTML = `
      <div class="applicationFooter">
        <a id="continueLink" href="#">Go to education</a>
        <input id="industry" type="text" value="${commitValue ? "Alpha" : ""}" />
      </div>
      <p>loading</p>
    `;
  });

  (document as unknown as { elementFromPoint: () => unknown }).elementFromPoint = () =>
    document.getElementById("continueLink");
  const documentElement = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate = (
    expr: string
  ) => {
    const node = expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr);
    return { singleNodeValue: node };
  };

  const session = { on: () => {}, off: () => {} };
  const page: Page = {
    evaluate: async (expr: unknown): Promise<unknown> => {
      const src = String(expr);
      const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
        d: unknown,
        x: unknown
      ) => unknown;
      return fn(document, win.XPathResult);
    },
    url: () => currentUrl,
    title: async () => currentTitle,
    // Forces attemptN16TrustedClick down its outer catch and into the
    // synthetic el.click() fallback.
    locator: () => ({
      first: () => ({
        click: async () => {
          throw new Error("not actionable");
        },
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async () => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;

  const stagehand: Stagehand = {
    act: vi.fn().mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: CONTINUE_STEP,
      actions: [
        { selector: `xpath=${continueXPath}`, description: "Go to education", method: "click" },
      ],
    }),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;

  return { page, stagehand, getClickActivations: () => clickActivations };
}

describe("flow-runner n+16 fallback — select step committed-value readback", () => {
  const go = (h: ReturnType<typeof buildHarness>, lines: string[]) =>
    executeStepWithHealing({
      stagehand: h.stagehand,
      page: h.page,
      step: CONTINUE_STEP,
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
      logger: makeLogger(lines),
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
      onStepFailure: () => null,
    } as never);

  it("does not credit weak DOM signals when the select target never committed", async () => {
    const h = buildHarness(false);
    const lines: string[] = [];
    await expect(go(h, lines)).rejects.toThrow(/verification|attempts/i);
    expect(lines.some((l) => l.includes("select step target value unchanged"))).toBe(true);
  });

  it("still credits when the select target committed the value", async () => {
    const h = buildHarness(true);
    const lines: string[] = [];
    const r = await go(h, lines).catch((e) => {
      throw e;
    });
    expect(r).toBeTruthy();
    expect(lines.some((l) => l.includes("select step target value unchanged"))).toBe(false);
  });
});
