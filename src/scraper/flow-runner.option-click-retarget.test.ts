import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression for bugfix-003: the n+16 native-click fallback's generated click
 * expression (`flow-runner.ts`'s `executeStepWithHealing`) retargets a
 * resolved leaf onto the nearest ancestor-or-self carrying a selection
 * marker (`retargetToSelectionMarkerExpr` in `browser-click-expr.ts`) before
 * activating and, when a marker was actually matched, dispatching a `change`
 * event. Stagehand's absolute xpath can resolve to a purely decorative
 * descendant (an icon `<span>`) of the real `role="option"` element, whose
 * commit handler is bound to the option itself rather than the icon. This
 * harness runs the ACTUAL generated expression string against a hand-rolled
 * DOM, proving the option ancestor — not the icon leaf Stagehand resolved —
 * is what receives the click() call and the change event.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

interface FakeElement {
  tagName: string;
  type?: string;
  attrs: Record<string, string>;
  children: FakeElement[];
  parentElement: FakeElement | null;
  clicked?: boolean;
  dispatched: Set<string>;
  click(): void;
  dispatchEvent(ev: { type: string }): boolean;
  querySelector(selector: string): FakeElement | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  focus(): void;
}

function makeElement(tag: string, attrs: Record<string, string> = {}): FakeElement {
  const el: FakeElement = {
    tagName: tag.toUpperCase(),
    attrs,
    children: [],
    parentElement: null,
    dispatched: new Set(),
    click() {
      el.clicked = true;
    },
    dispatchEvent(ev) {
      el.dispatched.add(ev.type);
      return true;
    },
    querySelector() {
      return null;
    },
    getAttribute(name: string) {
      return el.attrs[name] ?? null;
    },
    hasAttribute(name: string) {
      return Object.hasOwn(el.attrs, name);
    },
    focus() {},
  };
  return el;
}

function appendChild(parent: FakeElement, child: FakeElement): FakeElement {
  child.parentElement = parent;
  parent.children.push(child);
  return parent;
}

function parseXPathSteps(xp: string): { tag: string; idx: number }[] {
  return xp
    .split("/")
    .filter(Boolean)
    .map((step) => {
      const match = /^([a-zA-Z0-9]+)\[(\d+)\]$/.exec(step);
      if (!match) throw new Error(`unsupported xpath step in test fixture: ${step}`);
      const [, tag, idx] = match;
      // biome-ignore lint/style/noNonNullAssertion: guarded by the regex match above
      return { tag: tag!.toUpperCase(), idx: Number(idx) };
    });
}

/**
 * Absolute positional resolution — exactly what a live `document.evaluate`
 * does. The FIRST xpath step (`html[1]`) matches the root element itself
 * (the tree's `<html>` node, not one of its children); every subsequent
 * step descends into that node's children by tag + sibling position.
 */
function evaluateAbsolute(root: FakeElement, xp: string): FakeElement | null {
  const [firstStep, ...restSteps] = parseXPathSteps(xp);
  if (!firstStep || root.tagName !== firstStep.tag) return null;
  let current: FakeElement | null = root;
  for (const step of restSteps) {
    if (!current) return null;
    const candidates: FakeElement[] = current.children.filter((c) => c.tagName === step.tag);
    current = candidates[step.idx - 1] ?? null;
  }
  return current;
}

/**
 * Builds the option-list DOM: a `role="option"` element (the real selectable
 * option, the marker-bearing ancestor) wrapping a purely decorative icon
 * `<span>` with no attributes of its own — the leaf Stagehand's absolute
 * xpath resolves to.
 */
function buildTree(): { htmlRoot: FakeElement; option: FakeElement; icon: FakeElement } {
  const html = makeElement("html");
  const body = makeElement("body");
  appendChild(html, body);
  const page = makeElement("div");
  appendChild(body, page);

  const listbox = makeElement("div", { role: "listbox" });
  const option = makeElement("div", { role: "option", "aria-selected": "false" });
  const icon = makeElement("span");
  appendChild(option, icon);
  appendChild(listbox, option);
  appendChild(page, listbox);

  return { htmlRoot: html, option, icon };
}

/**
 * `frameTarget.evaluate` backed by the fake DOM above: runs the ACTUAL
 * expression string flow-runner.ts generates through `new Function`.
 */
function makeEvaluate(htmlRoot: FakeElement): FrameTarget["evaluate"] {
  const XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  class FakeEvent {
    type: string;
    constructor(type: string, _opts?: unknown) {
      this.type = type;
    }
  }
  const fakeDocument = {
    evaluate(xp: string) {
      const node = evaluateAbsolute(htmlRoot, xp);
      return { singleNodeValue: node };
    },
  };
  return (async (expr: unknown) => {
    const source = String(expr);
    const fn = new Function("document", "Event", "XPathResult", `return (${source});`) as (
      d: unknown,
      e: unknown,
      x: unknown
    ) => unknown;
    return fn(fakeDocument, FakeEvent, XPathResult);
  }) as FrameTarget["evaluate"];
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
    url: () => "https://shop.example.com/checkout",
    title: vi.fn().mockResolvedValue("Checkout"),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

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

describe("flow-runner/executeStepWithHealing — n+16 native-click fallback select-option retarget", () => {
  it("retargets activation onto the role=option ancestor, not the resolved icon leaf, and dispatches change", async () => {
    const { htmlRoot, option, icon } = buildTree();
    // Stagehand's absolute xpath lands on the decorative icon span nested
    // inside the real selectable option, not the option itself.
    const selector = "xpath=/html[1]/body[1]/div[1]/div[1]/div[1]/span[1]";

    guardedObserve.mockResolvedValue([
      { selector, description: "Standard shipping", method: "click" },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "Standard shipping",
      actions: [{ selector, description: "Standard shipping", method: "click" }],
    });

    const target: FrameTarget = {
      frame: {} as FrameTarget["frame"],
      frameSelector: "iframe#app",
      evaluate: makeEvaluate(htmlRoot),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      url: () => Promise.resolve("https://shop.example.com/checkout"),
      title: () => Promise.resolve("Checkout"),
    };

    const page = fakePage();

    // The fixture DOM never signals success by any of the OTHER n+16
    // corroboration checks (network/url/html-delta/text/formValue), so
    // verification exhausts its retries and executeStepWithHealing throws —
    // this test only cares about what the generated click expression
    // targeted, not the overall step outcome (out of scope for bugfix-003).
    await expect(
      executeStepWithHealing({
        stagehand: makeStagehand(),
        page,
        step: "Select the 'Standard shipping' option",
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
      } as never)
    ).rejects.toThrow();

    // The marker-bearing option ancestor — not the resolved icon leaf —
    // must be what actually receives activation (native click()) and the
    // change event, since a match on retargetToSelectionMarkerExpr found it.
    expect(option.clicked).toBe(true);
    expect(option.dispatched.has("change")).toBe(true);
    expect(icon.clicked).toBeUndefined();
    expect(icon.dispatched.size).toBe(0);
  });
});
