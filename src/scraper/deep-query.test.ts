import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { buildDeepSubmitClickExpr } from "@/scraper/deep-query";

/**
 * Minimal fake DOM element supporting exactly the surface the generated
 * expression touches (`tagName`, `getAttribute`, `textContent`, `closest`,
 * `querySelectorAll`, `shadowRoot`, `focus`, `dispatchEvent`). Not a real
 * DOM — just enough to let `node:vm` execute the actual generated
 * expression string against a hand-built tree, so the test exercises the
 * real traversal code rather than a re-implementation of it.
 */
interface FakeEl {
  tagName: string;
  attrs: Record<string, string>;
  textContent: string;
  parent: FakeEl | null;
  children: FakeEl[];
  shadowRoot: FakeRoot | null;
  clicked: boolean;
  focused: boolean;
  getAttribute(name: string): string | null;
  closest(selector: string): FakeEl | null;
  querySelectorAll(selector: "*"): FakeEl[];
  focus(): void;
  dispatchEvent(evt: { type: string }): void;
}

interface FakeRoot {
  querySelectorAll(selector: "*"): FakeEl[];
}

function makeEl(tagName: string, attrs: Record<string, string> = {}, textContent = ""): FakeEl {
  const el: FakeEl = {
    tagName: tagName.toUpperCase(),
    attrs,
    textContent,
    parent: null,
    children: [],
    shadowRoot: null,
    clicked: false,
    focused: false,
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? (attrs[name] ?? null) : null;
    },
    closest(selector) {
      const wantsForm = selector === "form";
      let node: FakeEl | null = el;
      while (node) {
        if (wantsForm && node.tagName === "FORM") return node;
        node = node.parent;
      }
      return null;
    },
    querySelectorAll() {
      return flattenDescendants(el.children);
    },
    focus() {
      el.focused = true;
    },
    dispatchEvent(evt) {
      if (evt.type === "click") el.clicked = true;
    },
  };
  return el;
}

function flattenDescendants(children: FakeEl[]): FakeEl[] {
  const out: FakeEl[] = [];
  for (const child of children) {
    out.push(child);
    out.push(...flattenDescendants(child.children));
  }
  return out;
}

function appendChild(parent: FakeEl, child: FakeEl): FakeEl {
  child.parent = parent;
  parent.children.push(child);
  return child;
}

function makeRoot(topLevel: FakeEl[]): FakeRoot {
  return {
    querySelectorAll() {
      return flattenDescendants(topLevel);
    },
  };
}

/**
 * Executes the generated expression string against a fake `document`
 * bound as global `document`, plus a minimal `Event` constructor (the
 * generated code only reads `.type` off it here).
 */
function evaluateInFakePage(expr: string, document: FakeRoot): unknown {
  return runInNewContext(expr, {
    document,
    Event: class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
    console,
  });
}

describe("deep-query/buildDeepSubmitClickExpr", () => {
  it("finds and clicks a submit-shaped control nested two shadow roots deep", () => {
    const innerButton = makeEl("button", { type: "submit" }, "Submit Application");
    const innerShadowRoot = makeRoot([innerButton]);
    const middleHost = makeEl("app-submit-button");
    middleHost.shadowRoot = innerShadowRoot;

    const outerShadowRoot = makeRoot([middleHost]);
    const outerHost = makeEl("app-form-wrapper");
    outerHost.shadowRoot = outerShadowRoot;

    const document = makeRoot([outerHost]);

    const result = evaluateInFakePage(buildDeepSubmitClickExpr(), document) as {
      found: boolean;
      clicked: boolean;
    };

    expect(result).toEqual({ found: true, clicked: true });
    expect(innerButton.clicked).toBe(true);
  });

  it("resolves a light-DOM-only submit button identically (no regression)", () => {
    const form = makeEl("form");
    const submitButton = appendChild(form, makeEl("button", { type: "submit" }, "Submit"));
    const document = makeRoot([form]);

    const result = evaluateInFakePage(buildDeepSubmitClickExpr(), document) as {
      found: boolean;
      clicked: boolean;
    };

    expect(result).toEqual({ found: true, clicked: true });
    expect(submitButton.clicked).toBe(true);
  });

  it("degrades to not-found (never throws) when the only submit control is behind a closed shadow root", () => {
    const closedHost = makeEl("app-closed-submit");
    closedHost.shadowRoot = null; // closed roots are invisible to page script
    const document = makeRoot([closedHost]);

    expect(() => {
      const result = evaluateInFakePage(buildDeepSubmitClickExpr(), document) as {
        found: boolean;
        clicked: boolean;
      };
      expect(result).toEqual({ found: false, clicked: false });
    }).not.toThrow();
  });

  it("locate-only mode reports found without clicking", () => {
    const button = makeEl("button", { type: "submit" }, "Submit");
    const document = makeRoot([button]);

    const result = evaluateInFakePage(
      buildDeepSubmitClickExpr({ clickIfFound: false }),
      document
    ) as { found: boolean; clicked: boolean };

    expect(result).toEqual({ found: true, clicked: false });
    expect(button.clicked).toBe(false);
  });
});
