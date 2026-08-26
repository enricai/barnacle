import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression for bugfix-002: the n+16 native-click fallback's element
 * resolution (`flow-runner.ts`'s `executeStepWithHealing`, ~xpath computed
 * from `resolvedAction.selector` then re-evaluated via `document.evaluate`)
 * used to give up (`fired=false kind=none`) whenever Stagehand's absolute,
 * purely positional xpath (`/html[1]/body[1]/div[1]/div[3]/label[1]/input[1]`
 * — no `@id`/`@name` predicates anywhere, per Stagehand's own
 * `nodeToAbsoluteXPath`) went stale between the moment it was resolved and
 * the fallback's later re-evaluate. A validation re-render triggered by an
 * earlier field's blur (inserting a banner/error node as a preceding sibling
 * of an ANCESTOR container) shifts every ancestor's positional index below
 * the insertion point, so the exact absolute path no longer matches the live
 * DOM even though the target checkbox never moved. This left a plain native
 * `<input type="checkbox">` with a clean id unclassified (`kind=none`),
 * `checkboxStateVerified` stuck at `false`, and the step credited only via
 * the weak `formValueChanged` OR-branch — the checkbox itself never
 * committed.
 *
 * This harness runs the ACTUAL generated browser-context expression strings
 * (not a canned mock return) against a tiny hand-rolled DOM + `document.evaluate`
 * implementation, so it exercises the real xpath-resolution logic rather than
 * asserting on which string shape was passed to a stub.
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
  checked?: boolean;
  children: FakeElement[];
  parentElement: FakeElement | null;
  clicked?: boolean;
  dispatched: Set<string>;
  click(): void;
  dispatchEvent(ev: { type: string }): boolean;
  querySelector(selector: string): FakeElement | null;
  getAttribute(_name: string): string | null;
  closest(_selector: string): FakeElement | null;
}

function makeElement(tag: string, attrs: { type?: string; checked?: boolean } = {}): FakeElement {
  const el: FakeElement = {
    tagName: tag.toUpperCase(),
    type: attrs.type,
    checked: attrs.checked ?? false,
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
    querySelector(selector: string) {
      const wanted = selector.split(",").map((s) => s.trim());
      const stack = [...el.children];
      while (stack.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: guarded by the length check above
        const node = stack.shift()!;
        for (const want of wanted) {
          const match = /^input\[type=(\w+)\]$/.exec(want);
          if (match && node.tagName === "INPUT" && node.type === match[1]) return node;
        }
        stack.push(...node.children);
      }
      return null;
    },
    getAttribute() {
      return null;
    },
    closest() {
      return null;
    },
  };
  return el;
}

function appendChild(parent: FakeElement, child: FakeElement): FakeElement {
  child.parentElement = parent;
  parent.children.push(child);
  return parent;
}

function localSiblingIndex(node: FakeElement): number {
  const parent = node.parentElement;
  if (!parent) return 1;
  const sameTag = parent.children.filter((c) => c.tagName === node.tagName);
  return sameTag.indexOf(node) + 1;
}

function parseXPathSteps(xp: string): { tag: string; idx: number }[] {
  return xp
    .split("/")
    .filter(Boolean)
    .map((step) => {
      const match = /^([a-zA-Z0-9]+)\[(\d+)\]$/.exec(step);
      if (!match) throw new Error(`unsupported xpath step in test fixture: ${step}`);
      return { tag: match[1].toUpperCase(), idx: Number(match[2]) };
    });
}

/** Absolute positional resolution — exactly what a live `document.evaluate` does. */
function evaluateAbsolute(root: FakeElement, xp: string): FakeElement | null {
  const steps = parseXPathSteps(xp);
  let current: FakeElement | null = root;
  for (const step of steps) {
    if (!current) return null;
    const candidates = current.children.filter((c) => c.tagName === step.tag);
    current = candidates[step.idx - 1] ?? null;
  }
  return current;
}

/** Relative descendant-chain resolution for the "//tail" re-anchor the fix adds. */
function evaluateTail(root: FakeElement, tail: string): FakeElement | null {
  const steps = parseXPathSteps(tail);
  const all: FakeElement[] = [];
  const collect = (node: FakeElement): void => {
    all.push(node);
    for (const child of node.children) collect(child);
  };
  collect(root);
  const matchesChain = (node: FakeElement): boolean => {
    let cur: FakeElement | null = node;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (!cur) return false;
      const step = steps[i];
      if (!step || cur.tagName !== step.tag || localSiblingIndex(cur) !== step.idx) return false;
      cur = cur.parentElement;
    }
    return true;
  };
  return all.find(matchesChain) ?? null;
}

/**
 * Builds the LIVE (post-validation-re-render) DOM tree for the checkbox
 * scenario. A banner div is inserted as the FIRST child of the page
 * container — modeling the earlier "Subscribe to updates" email/phone
 * fields' blur validation growing the DOM — which shifts every subsequent
 * sibling div's positional index by one. The checkbox itself never moved.
 */
function buildLiveTree(): { htmlRoot: FakeElement; checkbox: FakeElement } {
  const html = makeElement("html");
  const body = makeElement("body");
  appendChild(html, body);
  const page = makeElement("div");
  appendChild(body, page);

  const banner = makeElement("div"); // NEW — inserted by the earlier fields' validation
  const emailWrapper = makeElement("div");
  appendChild(emailWrapper, makeElement("input", { type: "email" }));
  const phoneWrapper = makeElement("div");
  appendChild(phoneWrapper, makeElement("input", { type: "tel" }));
  const checkboxWrapper = makeElement("div");
  const label = makeElement("label");
  const checkbox = makeElement("input", { type: "checkbox", checked: false });
  appendChild(label, checkbox);
  appendChild(checkboxWrapper, label);

  appendChild(page, banner);
  appendChild(page, emailWrapper);
  appendChild(page, phoneWrapper);
  appendChild(page, checkboxWrapper);

  return { htmlRoot: html, checkbox };
}

/**
 * `frameTarget.evaluate` backed by the fake DOM above: runs the ACTUAL
 * expression string flow-runner.ts generates through `new Function`, with a
 * `document.evaluate` that mirrors the real browser's XPath semantics
 * (absolute positional matching) plus the fix's "//tail" re-anchor path.
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
      const node = xp.startsWith("//") ? evaluateTail(htmlRoot, xp.slice(2)) : evaluateAbsolute(htmlRoot, xp);
      return { singleNodeValue: node };
    },
  };
  return (async (expr: unknown) => {
    const source = String(expr);
    // biome-ignore lint/security/noGlobalEval: intentional sandboxed test harness, not production code
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
    url: () => "https://careers.example.com/apply/job/1",
    title: vi.fn().mockResolvedValue("Apply"),
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

describe("flow-runner/executeStepWithHealing — n+16 native-click fallback checkbox xpath retarget", () => {
  it("resolves a stale positional xpath via the leaf tail and classifies a plain native checkbox (fired=true kind=checkbox)", async () => {
    const { htmlRoot, checkbox } = buildLiveTree();
    // The xpath Stagehand resolved BEFORE the earlier fields' validation
    // re-render inserted the banner div: absolute, purely positional, no
    // @id anywhere — exactly what Stagehand's `nodeToAbsoluteXPath` emits.
    const staleSelector = "xpath=/html[1]/body[1]/div[1]/div[3]/label[1]/input[1]";

    guardedObserve.mockResolvedValue([
      { selector: staleSelector, description: "Subscribe to updates", method: "click" },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "Subscribe to updates",
      actions: [
        { selector: staleSelector, description: "Subscribe to updates", method: "click" },
      ],
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
      url: () => Promise.resolve("https://careers.example.com/apply/job/1"),
      title: () => Promise.resolve("Apply"),
    };

    const page = fakePage();

    const outcome = await executeStepWithHealing(
      {
        stagehand: makeStagehand(),
        page,
        step: "Check the 'Subscribe to updates' checkbox",
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
      } as never
    );

    // Eliminates the reported false negative: the fallback must fire, must
    // classify the resolved element as a checkbox (not kind=none), and must
    // reflect the element's real, freshly-toggled `.checked` state — not the
    // weak formValueChanged OR-branch the report captured.
    expect(outcome).toBe("completed");
    expect(checkbox.checked).toBe(true);
    expect(checkbox.dispatched.has("click")).toBe(true);
    expect(checkbox.dispatched.has("change")).toBe(true);
  });
});
