import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { StepVerificationError } from "@/scraper/errors";
import { executeStepWithHealing, verifyDomEffect } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression for bugfix-003: the disabled/aria-disabled click veto
 * (DISABLED_MARKER_EL_EXPR) must also veto a click that resolves to a
 * decorative leaf (a plain `<span>` with no `disabled` property and no
 * `aria-disabled` of its own) nested inside a non-form clickable wrapper
 * (`<div role="button" aria-disabled="true">`) — the ancestor carries the
 * disabled state, not the resolved leaf.
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
  disabled?: boolean;
  children: FakeElement[];
  parentElement: FakeElement | null;
  dispatched: Set<string>;
  attrs: Record<string, string>;
  click(): void;
  focus(): void;
  dispatchEvent(ev: { type: string }): boolean;
  querySelector(_selector: string): FakeElement | null;
  querySelectorAll(_selector: string): FakeElement[];
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  matches(_selector: string): boolean;
  closest(_selector: string): FakeElement | null;
}

function makeElement(
  tag: string,
  attrs: { type?: string; disabled?: boolean; onClick?: () => void } = {}
): FakeElement {
  const el: FakeElement = {
    tagName: tag.toUpperCase(),
    type: attrs.type,
    disabled: attrs.disabled,
    children: [],
    parentElement: null,
    dispatched: new Set(),
    attrs: {},
    click() {
      attrs.onClick?.();
    },
    focus() {},
    dispatchEvent(ev) {
      el.dispatched.add(ev.type);
      return true;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getAttribute(name: string) {
      return el.attrs[name] ?? null;
    },
    hasAttribute(name: string) {
      return name in el.attrs;
    },
    matches() {
      return false;
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

function evaluateAbsolute(root: FakeElement, xp: string): FakeElement | null {
  const steps = parseXPathSteps(xp);
  const first = steps[0];
  if (!first || root.tagName !== first.tag) return null;
  let current: FakeElement | null = root;
  for (const step of steps.slice(1)) {
    if (!current) return null;
    const candidates: FakeElement[] = current.children.filter((c) => c.tagName === step.tag);
    current = candidates[step.idx - 1] ?? null;
  }
  return current;
}

/**
 * Builds `<html><body><div role="button" aria-disabled="true"><span></span></div></body></html>`
 * — the ancestor `div` carries `aria-disabled`, but Stagehand resolves the
 * click to the inner `span`, which has no disabled marker of its own.
 * `bodyRevision` grows every time the span's `click()` fires, modeling a
 * validation re-render whose htmlDelta/textChanged signal used to ride past
 * a directly-disabled target.
 */
function buildAncestorDisabledTree(): {
  htmlRoot: FakeElement;
  span: FakeElement;
  bodyRevision: { n: number };
} {
  const bodyRevision = { n: 0 };
  const html = makeElement("html");
  const body = makeElement("body");
  Object.defineProperty(body, "outerHTML", {
    get: () => "x".repeat(100 + bodyRevision.n * 52),
  });
  Object.defineProperty(body, "innerText", {
    get: () => `state-${bodyRevision.n}`,
  });
  appendChild(html, body);
  const wrapper = makeElement("div");
  wrapper.attrs.role = "button";
  wrapper.attrs["aria-disabled"] = "true";
  appendChild(body, wrapper);
  const span = makeElement("span", {
    onClick: () => {
      bodyRevision.n += 1;
    },
  });
  appendChild(wrapper, span);
  return { htmlRoot: html, span, bodyRevision };
}

function makeEvaluate(htmlRoot: FakeElement): FrameTarget["evaluate"] {
  const XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  class FakeEvent {
    type: string;
    constructor(type: string, _opts?: unknown) {
      this.type = type;
    }
  }
  const fakeDocument = {
    body: (htmlRoot.children[0] ?? null) as unknown,
    evaluate(xp: string) {
      const node = xp.startsWith("//") ? null : evaluateAbsolute(htmlRoot, xp);
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

describe("flow-runner — disabled ancestor click target veto", () => {
  it("verifyDomEffect never scores a click on a leaf nested inside an aria-disabled ancestor as verified", async () => {
    const { htmlRoot } = buildAncestorDisabledTree();
    const selector = "xpath=/html[1]/body[1]/div[1]/span[1]";
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

    const verified = await verifyDomEffect(target, {
      selector,
      method: "click",
      description: "wrapperSubmitButton",
      arguments: [],
    });
    expect(verified).toBe(false);
  });

  it("n+16 el.click() fallback never scores a click on a leaf nested inside an aria-disabled ancestor as verified despite a nonzero htmlDelta", async () => {
    const { htmlRoot, bodyRevision } = buildAncestorDisabledTree();
    const selector = "xpath=/html[1]/body[1]/div[1]/span[1]";

    guardedObserve.mockResolvedValue([
      { selector, description: "wrapperSubmitButton", method: "click" },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "wrapperSubmitButton",
      actions: [{ selector, description: "wrapperSubmitButton", method: "click" }],
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

    await expect(
      executeStepWithHealing({
        stagehand: makeStagehand(),
        page,
        step: "Click the wrapper submit button",
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
    ).rejects.toThrow(StepVerificationError);

    expect(bodyRevision.n).toBeGreaterThan(0);
  });
});
