import { describe, expect, it } from "vitest";

import { retargetToSelectionMarkerExpr } from "@/scraper/browser-click-expr";

/**
 * Regression for bugfix-003: `retargetToSelectionMarkerExpr` must reassign
 * `elVar` onto the nearest marker-bearing ancestor AND flip the caller's
 * match flag so the caller can gate a subsequent `change` dispatch — without
 * that flag, the n+16 fallback in `flow-runner.ts` would dispatch `change`
 * unconditionally on every click resolved through it, including plain
 * buttons/links that were never part of a selection widget.
 */

interface FakeElement {
  tagName: string;
  attributes: Map<string, string>;
  parentElement: FakeElement | null;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
}

function makeElement(tag: string, attrs: Record<string, string> = {}): FakeElement {
  const el: FakeElement = {
    tagName: tag.toUpperCase(),
    attributes: new Map(Object.entries(attrs)),
    parentElement: null,
    hasAttribute(name) {
      return el.attributes.has(name);
    },
    getAttribute(name) {
      return el.attributes.get(name) ?? null;
    },
    matches(selector) {
      return selector
        .split(",")
        .map((s) => s.trim())
        .some((s) => {
          const attrMatch = /^\[([\w-]+)\]$/.exec(s);
          return attrMatch ? el.attributes.has(attrMatch[1] as string) : false;
        });
    },
  };
  return el;
}

function link(parent: FakeElement, child: FakeElement): FakeElement {
  child.parentElement = parent;
  return child;
}

function run(el: FakeElement): { el: FakeElement; matched: boolean } {
  const body = `
    let el = __el;
    let matched = false;
    ${retargetToSelectionMarkerExpr("el", "matched")}
    return { el, matched };
  `;
  const fn = new Function("__el", body) as (e: FakeElement) => { el: FakeElement; matched: boolean };
  return fn(el);
}

describe("retargetToSelectionMarkerExpr", () => {
  it("retargets onto a role=option ancestor and reports a match", () => {
    const option = makeElement("div", { role: "option" });
    const iconSpan = link(option, makeElement("span"));

    const result = run(iconSpan);

    expect(result.el).toBe(option);
    expect(result.matched).toBe(true);
  });

  it("retargets onto a data-baseweb component-kit ancestor", () => {
    const widget = makeElement("div", { "data-baseweb": "menu-item" });
    const label = link(widget, makeElement("span"));

    const result = run(label);

    expect(result.el).toBe(widget);
    expect(result.matched).toBe(true);
  });

  it("leaves the leaf untouched and reports no match when no ancestor carries a marker", () => {
    const container = makeElement("div");
    const button = link(container, makeElement("button"));

    const result = run(button);

    expect(result.el).toBe(button);
    expect(result.matched).toBe(false);
  });

  it("does not walk past MAX_SELECTION_ANCESTOR_DEPTH ancestors", () => {
    const option = makeElement("div", { role: "option" });
    let leaf: FakeElement = option;
    for (let i = 0; i < 7; i++) {
      leaf = link(leaf, makeElement("span"));
    }

    const result = run(leaf);

    expect(result.matched).toBe(false);
    expect(result.el).toBe(leaf);
  });
});
