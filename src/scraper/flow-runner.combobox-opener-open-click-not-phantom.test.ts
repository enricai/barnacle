import type { Action } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { verifyDomEffect } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Regression coverage for the reported defect: a raw click resolved onto a
 * `role=combobox` opener (e.g. a replanner-generated two-step "click to open
 * the dropdown" instruction) that genuinely opens its owned option panel was
 * scored `phantom`, because opening only flips `aria-expanded` — which the
 * selection-fingerprint machinery deliberately excludes (by design, to avoid
 * crediting a bare accordion/tooltip disclosure). Exercises the REAL
 * generated expression strings (`comboboxOpenerPanelOpened`'s browser-side
 * `evaluate` body) against a live happy-dom document, not a hand-mocked
 * boolean, so a future edit to the expression itself is what this test
 * verifies.
 *
 * A companion negative case guards the pre-existing deliberate exclusion this
 * fix must not weaken: a bare accordion/tooltip trigger whose `aria-expanded`
 * flips true but exposes no `role=option` content stays `phantom`.
 */

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

/** Wires the real generated expression strings against a live happy-dom document. */
function makeTarget(window: Window): FrameTarget {
  const document = window.document;
  const documentElement = document.documentElement as unknown as HappyDomElement;
  const win = window as unknown as { XPathResult?: unknown };
  win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate = (
    expr: string
  ) => {
    const node = expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr);
    return { singleNodeValue: node };
  };

  const evaluate = (async (expr: unknown): Promise<unknown> => {
    const src = String(expr);
    const fn = new window.Function("document", `return (${src});`) as (d: unknown) => unknown;
    return fn(document);
  }) as FrameTarget["evaluate"];

  return {
    frame: null,
    frameSelector: null,
    evaluate,
    locator: (() => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    })) as unknown as FrameTarget["locator"],
    url: () => Promise.resolve("https://directory.example.com/results"),
    title: () => Promise.resolve("Results"),
  } as unknown as FrameTarget;
}

/** Baseline fingerprint for a collapsed trigger — every tracked field blank/false. */
function collapsedBaseline() {
  return {
    kind: "",
    cls: "",
    ariaPressed: "",
    ariaChecked: "",
    ariaSelected: "",
    dataState: "",
    dataSelected: "",
    dataChecked: "",
    checked: "",
    value: "",
    ariaExpanded: "false",
  };
}

const clickActionFor = (selector: string): Action =>
  ({
    selector,
    description: "region opener",
    method: "click",
  }) as Action;

describe("flow-runner/verifyDomEffect — combobox opener open-click credit", () => {
  it("credits a role=combobox opener whose click opened its owned option panel", async () => {
    const window = new Window({ url: "https://directory.example.com/results" });
    const document = window.document;
    document.body.innerHTML = `
      <div class="region-picker">
        <button role="combobox" aria-haspopup="listbox" aria-owns="region-listbox" aria-expanded="false">
          Choose a region
        </button>
        <ul id="region-listbox" role="listbox" hidden></ul>
      </div>
    `;

    const trigger = document.querySelector('[role="combobox"]') as unknown as HappyDomElement & {
      setAttribute: (name: string, value: string) => void;
    };
    const listbox = document.getElementById("region-listbox") as unknown as {
      innerHTML: string;
    };

    (
      trigger as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      trigger.setAttribute("aria-expanded", "true");
      listbox.innerHTML = '<li role="option">North America</li><li role="option">Europe</li>';
    });

    const target = makeTarget(window);
    const xpath = absoluteXPathFor(trigger);
    const selector = `xpath=${xpath}`;
    const pre = { [xpath]: collapsedBaseline() };

    (trigger as unknown as { click: () => void }).click();

    expect(await verifyDomEffect(target, clickActionFor(selector), pre)).toBe(true);
  });

  it("does NOT credit a bare accordion/tooltip trigger that flips aria-expanded but owns no option content", async () => {
    const window = new Window({ url: "https://directory.example.com/results" });
    const document = window.document;
    document.body.innerHTML = `
      <div class="faq-item">
        <button role="combobox" aria-haspopup="listbox" aria-owns="faq-panel" aria-expanded="false">
          What is your return policy?
        </button>
        <div id="faq-panel" hidden>We accept returns within 30 days.</div>
      </div>
    `;

    const trigger = document.querySelector('[role="combobox"]') as unknown as HappyDomElement & {
      setAttribute: (name: string, value: string) => void;
    };
    const panel = document.getElementById("faq-panel") as unknown as { hidden: boolean };

    (
      trigger as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      trigger.setAttribute("aria-expanded", "true");
      panel.hidden = false;
    });

    const target = makeTarget(window);
    const xpath = absoluteXPathFor(trigger);
    const selector = `xpath=${xpath}`;
    const pre = { [xpath]: collapsedBaseline() };

    (trigger as unknown as { click: () => void }).click();

    expect(await verifyDomEffect(target, clickActionFor(selector), pre)).toBe(false);
  });

  it("does NOT credit an opener with no aria-controls/aria-owns and no inline popup, even when an unrelated widget elsewhere on the page has open options", async () => {
    const window = new Window({ url: "https://directory.example.com/results" });
    const document = window.document;
    document.body.innerHTML = `
      <button data-automation-id="promptIcon" aria-expanded="false">Open</button>
      <ul role="listbox"><li role="option">Unrelated option from a different widget</li></ul>
    `;

    const trigger = document.querySelector(
      '[data-automation-id="promptIcon"]'
    ) as unknown as HappyDomElement & {
      setAttribute: (name: string, value: string) => void;
    };

    (
      trigger as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      trigger.setAttribute("aria-expanded", "true");
    });

    const target = makeTarget(window);
    const xpath = absoluteXPathFor(trigger);
    const selector = `xpath=${xpath}`;
    const pre = { [xpath]: collapsedBaseline() };

    (trigger as unknown as { click: () => void }).click();

    expect(await verifyDomEffect(target, clickActionFor(selector), pre)).toBe(false);
  });
});
