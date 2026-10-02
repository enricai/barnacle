import { describe, expect, it } from "vitest";

import { RESOLVE_SHADOW_INTERACTIVE_DESCENDANT_EXPR } from "@/scraper/browser-click-expr";

/**
 * Regression for bugfix-001's conformance pass: `RESOLVE_SHADOW_INTERACTIVE_DESCENDANT_EXPR`
 * was previously unexercised outside of `flow-runner.trusted-click-retry-shadow-host-inert-acceptance.test.ts`,
 * which mocks the resolver's `evaluate()` call entirely rather than running
 * the expression body. `typeof el.click === "function"` is true for every
 * `HTMLElement` (not just real controls), so a naive interactivity check
 * built on it would match the first visible, enabled wrapper `<div>` in
 * document order instead of the actual `<button>` nested inside it.
 */

interface FakeElement {
  tagName: string;
  attributes: Map<string, string>;
  children: FakeElement[];
  shadowRoot: FakeElement | null;
  disabled?: boolean;
  rect: { width: number; height: number };
  style: { display: string; visibility: string };
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { width: number; height: number };
  querySelectorAll(selector: string): FakeElement[];
  // Every real HTMLElement exposes a generic, parameterless `.click()` — a
  // `<div>` included — which is exactly what makes `typeof el.click ===
  // "function"` useless as an interactivity signal.
  click(): void;
}

function makeElement(
  tag: string,
  attrs: Record<string, string> = {},
  opts: { disabled?: boolean; hidden?: boolean } = {}
): FakeElement {
  const el: FakeElement = {
    tagName: tag.toUpperCase(),
    attributes: new Map(Object.entries(attrs)),
    children: [],
    shadowRoot: null,
    disabled: opts.disabled,
    rect: opts.hidden ? { width: 0, height: 0 } : { width: 10, height: 10 },
    style: { display: "block", visibility: "visible" },
    hasAttribute(name) {
      return el.attributes.has(name);
    },
    getAttribute(name) {
      return el.attributes.get(name) ?? null;
    },
    getBoundingClientRect() {
      return el.rect;
    },
    querySelectorAll() {
      const out: FakeElement[] = [];
      const walk = (node: FakeElement) => {
        for (const child of node.children) {
          out.push(child);
          walk(child);
        }
      };
      walk(el);
      return out;
    },
    click() {
      // no-op, matching a real DOM's generic HTMLElement.click()
    },
  };
  return el;
}

function appendChild(parent: FakeElement, child: FakeElement): FakeElement {
  parent.children.push(child);
  return child;
}

function resolve(host: FakeElement): FakeElement | null {
  const fn = new Function(
    "__host",
    "getComputedStyle",
    `const resolve = ${RESOLVE_SHADOW_INTERACTIVE_DESCENDANT_EXPR}; return resolve(__host);`
  ) as (
    h: FakeElement,
    gcs: (el: FakeElement) => { display: string; visibility: string }
  ) => FakeElement | null;
  return fn(host, (el) => el.style);
}

describe("RESOLVE_SHADOW_INTERACTIVE_DESCENDANT_EXPR", () => {
  it("returns null when the host has no shadow root", () => {
    const host = makeElement("card-widget");
    expect(resolve(host)).toBeNull();
  });

  it("skips a wrapper div that merely exposes the generic HTMLElement.click() method and resolves the real button", () => {
    const host = makeElement("card-widget");
    host.shadowRoot = makeElement("shadow-root");
    const wrapperDiv = appendChild(host.shadowRoot, makeElement("div"));
    const button = appendChild(wrapperDiv, makeElement("button"));

    expect(resolve(host)).toBe(button);
  });

  it("skips a hidden and a disabled candidate in favor of the real visible, enabled control", () => {
    const host = makeElement("card-widget");
    host.shadowRoot = makeElement("shadow-root");
    appendChild(host.shadowRoot, makeElement("button", {}, { hidden: true }));
    appendChild(host.shadowRoot, makeElement("button", {}, { disabled: true }));
    const realButton = appendChild(host.shadowRoot, makeElement("button"));

    expect(resolve(host)).toBe(realButton);
  });

  it("resolves a role=button div when there is no native button", () => {
    const host = makeElement("card-widget");
    host.shadowRoot = makeElement("shadow-root");
    const roleButton = appendChild(host.shadowRoot, makeElement("div", { role: "button" }));

    expect(resolve(host)).toBe(roleButton);
  });

  it("returns null when every descendant is a plain, non-interactive div", () => {
    const host = makeElement("card-widget");
    host.shadowRoot = makeElement("shadow-root");
    appendChild(host.shadowRoot, makeElement("div"));
    appendChild(host.shadowRoot, makeElement("span"));

    expect(resolve(host)).toBeNull();
  });
});
