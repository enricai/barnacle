import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { StepVerificationError } from "@/scraper/errors";
import { executeStepWithHealing, verifyDomEffect } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import type { Logger } from "@/types/logging";

/**
 * Regression: the disabled/aria-disabled click veto (DISABLED_MARKER_EL_EXPR)
 * must veto a click resolving to a native `<input type="submit"
 * disabled="disabled">` — the boolean HTML attribute expressed with its
 * string value `"disabled"`, the exact shape reported in the recon repro.
 * Existing veto coverage only exercises `<button disabled>` and a
 * `<div role="button" aria-disabled="true">` wrapper; neither is a native
 * form submit control.
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
  attrs: { type?: string; disabled?: boolean; class?: string; onClick?: () => void } = {}
): FakeElement {
  const el: FakeElement = {
    tagName: tag.toUpperCase(),
    type: attrs.type,
    disabled: attrs.disabled,
    children: [],
    parentElement: null,
    dispatched: new Set(),
    attrs: {
      ...(attrs.disabled ? { disabled: "disabled" } : {}),
      ...(attrs.class !== undefined ? { class: attrs.class } : {}),
    },
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
 * Builds `<html><body><form><input type="submit" disabled="disabled"></form></body></html>`
 * (or the same tree without `disabled` when `disabled` is `false`, for the
 * control group). Clicking the input both grows `bodyRevision` (modeling a
 * validation re-render whose htmlDelta/textChanged/formValueChanged signal
 * used to ride past a directly-disabled target) AND flips the input's own
 * `class` attribute — the element-scoped selection fingerprint
 * `verifyDomEffect`'s click branch actually diffs.
 */
function buildSubmitInputTree(disabled: boolean): {
  htmlRoot: FakeElement;
  input: FakeElement;
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
  const form = makeElement("form");
  appendChild(body, form);
  const input = makeElement("input", {
    type: "submit",
    disabled,
    class: "btn-idle",
    onClick: () => {
      bodyRevision.n += 1;
      input.attrs.class = "btn-active";
    },
  });
  appendChild(form, input);
  return { htmlRoot: html, input, bodyRevision };
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

function makeTarget(htmlRoot: FakeElement): FrameTarget {
  return {
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
}

describe("flow-runner — disabled native submit input click veto", () => {
  const XPATH = "/html[1]/body[1]/form[1]/input[1]";
  const selector = `xpath=${XPATH}`;
  const preSelectionState = {
    [XPATH]: {
      kind: "",
      cls: "btn-idle",
      ariaPressed: "",
      ariaChecked: "",
      ariaSelected: "",
      dataState: "",
      dataSelected: "",
      dataChecked: "",
      checked: "",
      value: "",
    },
  };

  it("verifyDomEffect never scores a click on a disabled native submit input as verified, even though its own class fingerprint moved (a validation re-render)", async () => {
    const { htmlRoot, input } = buildSubmitInputTree(true);
    input.click();

    const verified = await verifyDomEffect(
      makeTarget(htmlRoot),
      {
        selector,
        method: "click",
        description: "submitApplication",
        arguments: [],
      },
      preSelectionState
    );
    expect(verified).toBe(false);
  });

  it("n+16 el.click() fallback never scores a click on a disabled native submit input as verified despite a nonzero htmlDelta", async () => {
    const { htmlRoot, bodyRevision } = buildSubmitInputTree(true);

    guardedObserve.mockResolvedValue([
      { selector, description: "submitApplication", method: "click" },
    ]);
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "submitApplication",
      actions: [{ selector, description: "submitApplication", method: "click" }],
    });

    const page = fakePage();

    await expect(
      executeStepWithHealing({
        stagehand: makeStagehand(),
        page,
        step: "Click the submit button",
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
        frameTarget: makeTarget(htmlRoot),
      } as never)
    ).rejects.toThrow(StepVerificationError);

    expect(bodyRevision.n).toBeGreaterThan(0);
  });

  it("control group: the same markup without `disabled` DOES verify once the click fingerprint moves", async () => {
    const { htmlRoot, input } = buildSubmitInputTree(false);
    input.click();

    const verified = await verifyDomEffect(
      makeTarget(htmlRoot),
      {
        selector,
        method: "click",
        description: "submitApplication",
        arguments: [],
      },
      preSelectionState
    );
    expect(verified).toBe(true);
  });
});
