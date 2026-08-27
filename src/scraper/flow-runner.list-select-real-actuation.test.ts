import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Pins required item 1's actuation clause: the n+16 native-click fallback
 * (`flow-runner.ts`'s `clickExpr`, exercised through `retargetToSelectionMarkerExpr`
 * + `clickActivationExpr` from `browser-click-expr.ts`) must deliver a REAL
 * click a genuinely-attached `addEventListener` on the option receives, not a
 * DOM mutation that bypasses event dispatch. Runs against a live happy-dom
 * document (real `addEventListener`, real `Element.click()`) — mirroring
 * `flow-runner.frame-primitives.test.ts`'s "n+16 native-click fallback
 * real-DOM checkbox classification" suite — rather than a mocked `evaluate()`
 * string, so the assertion is on genuine event delivery, independently
 * checkable without assuming which internal helper performs the click.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

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

/** Mirrors Stagehand's `nodeToAbsoluteXPath`: pure tag+sibling-position steps, no `@id`/`@name`. */
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

function makeStagehand(): Stagehand {
  return {} as unknown as Stagehand;
}

function fakePage(): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(null),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    url: () => "https://careers.example.com/apply/job/1",
    title: vi.fn().mockResolvedValue("Apply"),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

describe("flow-runner/executeStepWithHealing — n+16 select-option actuation delivers a real event a genuine listener receives", () => {
  it("fires the option's own addEventListener('click', ...) commit handler and sets the hidden committed-value input, not a label-only mutation", async () => {
    const window = new Window({ url: "https://careers.example.com/apply/job/1" });
    const document = window.document;
    document.body.innerHTML = `
      <div class="ComboboxContainer">
        <div role="listbox">
          <li role="option" data-value="us">United States</li>
        </div>
        <input type="hidden" id="country_value" value="" />
      </div>
    `;
    const optionEl = document.querySelector("li[role='option']") as unknown as HappyDomElement;
    expect(optionEl).not.toBeNull();

    // A genuinely-attached listener standing in for a site's own selection
    // commit code — the ONLY way this fires is a real click/selection event
    // the browser delivers to the option, never a DOM read/mutation.
    const hiddenInput = document.getElementById("country_value") as unknown as {
      value: string;
    };
    let commitHandlerCalls = 0;
    let commitEventWasMouseEvent = false;
    (
      optionEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", (ev) => {
      commitHandlerCalls += 1;
      // A bare `new Event("click")` — a DOM signal with no gesture behind it
      // — is rejected as a real user activation by React/design-system
      // widgets (see browser-click-expr.ts's docblock); a genuine `MouseEvent`
      // instance is what proves this was a real activation, not a label-only
      // mutation dressed up as a click.
      commitEventWasMouseEvent = ev instanceof window.MouseEvent;
      hiddenInput.value = "us";
    });

    const xpath = absoluteXPathFor(optionEl);
    const documentElement = document.documentElement as unknown as HappyDomElement;
    // happy-dom implements neither `XPathResult` nor `document.evaluate` — polyfill
    // only that, resolving by walking the REAL DOM tree by tag+position.
    const win = window as unknown as { XPathResult?: unknown };
    win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
    (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate =
      (expr: string) => {
        const node = expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr);
        return { singleNodeValue: node };
      };

    let n16ProbeResult: unknown;
    // Executes every generated expression string FOR REAL against the live
    // happy-dom document — `window.Function` runs in the window's own realm,
    // so bare references the production expressions make to `document`,
    // `XPathResult`, `Event`, `getComputedStyle` all resolve without being
    // threaded through as explicit params. This is the same approach
    // `prompt-widget-dom-harness.test-helper.ts` uses, applied here to the
    // n+16 fallback's real expression strings instead of a canned mock.
    const evaluate = (async (expr: unknown): Promise<unknown> => {
      const src = String(expr);
      const fn = new window.Function("document", `return (${src});`) as (d: unknown) => unknown;
      const result = fn(document);
      if (src.includes('el.click !== "function"')) n16ProbeResult = result;
      return result;
    }) as FrameTarget["evaluate"];
    const target: FrameTarget = {
      frame: null,
      frameSelector: null,
      evaluate,
      locator: vi.fn() as unknown as FrameTarget["locator"],
      url: () => Promise.resolve("https://careers.example.com/apply/job/1"),
      title: () => Promise.resolve("Apply"),
    };

    const selector = `xpath=${xpath}`;
    guardedObserve.mockResolvedValue([
      { selector, description: "United States option", method: "click" },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "United States option",
      actions: [{ selector, description: "United States option", method: "click" }],
    });

    const page = fakePage();

    const outcome = await executeStepWithHealing({
      stagehand: makeStagehand(),
      page,
      step: "Select 'United States' from the country combobox",
      optional: false,
      upload: false,
      submitStep: false,
      stepIndex: 0,
      totalSteps: () => 1,
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
      frameTarget: target,
    } as never);

    expect(outcome).toBe("completed");
    // The option was actuated via a real click delivered to a genuinely
    // attached listener, not a synthetic mutation that bypasses dispatch.
    expect(commitHandlerCalls).toBe(1);
    expect(commitEventWasMouseEvent).toBe(true);
    expect(hiddenInput.value).toBe("us");
    expect((n16ProbeResult as { fired: boolean }).fired).toBe(true);
  });
});
