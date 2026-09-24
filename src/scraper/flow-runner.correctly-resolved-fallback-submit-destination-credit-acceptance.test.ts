import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * True-positive counterpart to flow-runner.submit-shaped-weak-signal-veto-
 * acceptance.test.ts (bugfix-002's widened judge gate): an UNFLAGGED,
 * non-final click step whose resolved control is an objectively
 * submit-shaped affordance (a `<button type="submit">` inside a `<form>`)
 * still gets credited when the click genuinely lands the flow on a success
 * destination — a URL matching `successUrlFragments`, a title matching
 * `successPageTitleHints`, and a DOM node matching `submittedStateSelectors`
 * all present. Pins that widening the judge trigger to re-litigate
 * attribute-detected submit-shaped clicks (b2a26ec) did not turn into a
 * blanket false-negative for the genuine-success case: with `anthropic:
 * null` the judge is unavailable, so credit falls back to the deterministic
 * submitted-state DOM-selector probe, exactly the path a real judge would
 * corroborate with the URL/title signals too.
 */

const BASE_URL = "https://apply.example.com/step/1";
const SUCCESS_URL = "https://apply.example.com/step/1/success";
const SUBMIT_STEP_INSTRUCTION = "Click the button to continue";
const HARMLESS_SECOND_STEP = "Click the 'Details' link";
const SUBMITTED_STATE_SELECTOR = ".app-submitted-page";

function makeLogger(): { logger: Logger; info: string[]; warn: string[] } {
  const info: string[] = [];
  const warn: string[] = [];
  const logger = {
    info: vi.fn((msg: string) => info.push(msg)),
    warn: vi.fn((msg: string) => warn.push(msg)),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  return { logger, info, warn };
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

/**
 * Builds the offline fixture: a two-step flow whose first step's trusted
 * click resolves onto a `<button type="submit">` and whose click handler
 * navigates the (mutable) page URL to a success fragment, retitles the
 * page with a success hint, and renders a submitted-state DOM marker — the
 * genuine, correctly-resolved counterpart to the weak-signal veto fixture.
 */
function buildFixture(): {
  page: Page;
  stagehand: Stagehand;
  steps: HealingFlowStep[];
  logger: Logger;
  info: string[];
  warn: string[];
} {
  const window = new Window({ url: BASE_URL });
  const document = window.document;
  document.body.innerHTML = `
    <div class="wizardFooter">
      <form id="theForm">
        <button id="theControl" type="submit">Continue</button>
      </form>
      <a id="detailsLink" href="#details">Details</a>
    </div>
  `;

  const controlEl = document.getElementById("theControl") as unknown as HappyDomElement;
  const detailsLinkEl = document.getElementById("detailsLink") as unknown as HappyDomElement;
  if (!controlEl || !detailsLinkEl) throw new Error("fixture setup failed");

  const controlXPath = absoluteXPathFor(controlEl);
  const detailsLinkXPath = absoluteXPathFor(detailsLinkEl);

  const state = { url: BASE_URL, title: "Apply — Step 1", clicks: 0 };

  (
    controlEl as unknown as {
      addEventListener: (type: string, cb: (ev: unknown) => void) => void;
    }
  ).addEventListener("click", () => {
    // Genuine success destination: URL transitions to a fragment matching
    // successUrlFragments, the title matches successPageTitleHints, AND a
    // submitted-state DOM marker renders — the correctly-resolved-fallback
    // counterpart to the weak-signal veto fixture's byte-positive reset.
    // The act() mock (below) resolves BOTH flow steps onto this same
    // control (mirroring the shared fixture's sibling tests), so the click
    // count is folded into the URL to keep producing a fresh urlChanged
    // signal on the harmless second step's re-click too.
    state.clicks += 1;
    state.url = `${SUCCESS_URL}#${state.clicks}`;
    state.title = "Apply — Submitted";
    const marker = document.createElement("div");
    marker.setAttribute("class", "app-submitted-page");
    document.body.appendChild(marker as unknown as HappyDomElement);
  });

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
    url: () => state.url,
    title: async () => state.title,
    locator: () => ({
      first: () => ({
        click: async () => {
          (controlEl as unknown as { click: () => void }).click();
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
    // Stagehand's own act() never touches the DOM — the trusted click
    // delivery below (`page.locator(...).first().click()`) fires the real
    // handler, matching every other offline acceptance test in this suite.
    act: vi.fn().mockImplementation(async () => ({
      success: true,
      message: "clicked",
      actionDescription: "clicked",
      actions: [{ selector: `xpath=${controlXPath}`, description: "control", method: "click" }],
    })),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? []
          : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
      ),
  } as unknown as Stagehand;
  void detailsLinkXPath;

  const steps: HealingFlowStep[] = [
    { instruction: SUBMIT_STEP_INSTRUCTION, optional: false, upload: false, submitStep: false },
    { instruction: HARMLESS_SECOND_STEP, optional: true, upload: false, submitStep: false },
  ];

  const { logger, info, warn } = makeLogger();
  return { page, stagehand, steps, logger, info, warn };
}

describe("flow-runner submit-shaped step — correctly-resolved click to a genuine success destination still credits", () => {
  it("credits an UNFLAGGED, non-final click onto a correctly-resolved submit-shaped control whose destination matches success URL/title/DOM signals", async () => {
    const { page, stagehand, steps, logger, info } = buildFixture();

    const result = await runHealingFlow({
      stagehand,
      page,
      steps,
      logger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      submittedStateSelectors: [SUBMITTED_STATE_SELECTOR],
      successUrlFragments: ["/success"],
      successPageTitleHints: ["Submitted"],
    });

    // The widened judge gate (bugfix-002) re-litigates this step because
    // the resolved control is submit-shaped, but with `anthropic: null`
    // the judge is unavailable and credit falls back to the deterministic
    // submitted-state DOM probe — the true-positive path must still credit
    // the step and let the flow reach its final (harmless) step.
    expect(result.lastStepIndex).toBe(1);
    expect(
      info.some((line) =>
        line.includes(
          `submit verified via submitted-state DOM selector '${SUBMITTED_STATE_SELECTOR}'`
        )
      )
    ).toBe(true);
    expect(info.some((line) => line.includes("succeeded on attempt 1"))).toBe(true);
  });
});
