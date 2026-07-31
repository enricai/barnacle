import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  buildClickByDeepIndexExpr,
  buildRankSubmitCandidatesExpr,
  type SubmitCandidate,
} from "@/scraper/submit-control";

/**
 * Pins the submit-control resolver's contract against the bug report's
 * anchor scenario: a light DOM with no `type="submit"` and no literal
 * "Submit" text, because the actual control is rendered inside a web
 * component's shadow root (Angular Elements / Stencil). Mirrors the fake-DOM
 * fixture shape from `submit-control.test.ts` and `deep-query.test.ts` so
 * these tests execute the real generated expression strings, not a
 * re-implementation of the traversal.
 */
interface FakeEl {
  tagName: string;
  attrs: Record<string, string>;
  textContent: string;
  children: FakeEl[];
  shadowRoot: FakeRoot | null;
  clicked: boolean;
  focused: boolean;
  getAttribute(name: string): string | null;
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
    children: [],
    shadowRoot: null,
    clicked: false,
    focused: false,
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? (attrs[name] ?? null) : null;
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

function makeRoot(topLevel: FakeEl[]): FakeRoot {
  return {
    querySelectorAll() {
      return flattenDescendants(topLevel);
    },
  };
}

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

/** Resolves the top-ranked submit candidate, if any, then clicks it — the two-round-trip contract a caller (flow-runner's click cascade) would follow. */
function resolveAndClickTopCandidate(document: FakeRoot): {
  handle: SubmitCandidate | null;
  clicked: boolean;
} {
  const ranked = evaluateInFakePage(buildRankSubmitCandidatesExpr(), document) as SubmitCandidate[];
  const handle = ranked[0] ?? null;
  if (!handle) return { handle: null, clicked: false };
  const result = evaluateInFakePage(buildClickByDeepIndexExpr(handle.deepIndex), document) as {
    clicked: boolean;
  };
  return { handle, clicked: result.clicked };
}

describe("shadow-dom-resolve/submit-control resolver contract", () => {
  it("resolves a handle for a submit control nested one shadow root deep with no light-DOM submit signal", () => {
    const shadowSubmit = makeEl("button", { type: "submit" }, "Submit Application");
    const shadowRoot = makeRoot([shadowSubmit]);
    const host = makeEl("app-submit-button");
    host.shadowRoot = shadowRoot;

    // Light DOM contains no type="submit" and no literal "Submit" text —
    // mirrors the bug report's captured bodyOuterHtml evidence.
    const nav = makeEl("nav", {}, "Back");
    const document = makeRoot([nav, host]);

    const { handle, clicked } = resolveAndClickTopCandidate(document);

    expect(handle).not.toBeNull();
    expect(handle?.tier).toBe(3);
    expect(clicked).toBe(true);
    expect(shadowSubmit.clicked).toBe(true);
  });

  it("resolves a handle for a submit control nested two shadow roots deep with no light-DOM submit signal", () => {
    const innerButton = makeEl("button", { type: "submit" }, "Submit Application");
    const innerShadowRoot = makeRoot([innerButton]);
    const middleHost = makeEl("app-submit-button");
    middleHost.shadowRoot = innerShadowRoot;

    const outerShadowRoot = makeRoot([middleHost]);
    const outerHost = makeEl("app-form-wrapper");
    outerHost.shadowRoot = outerShadowRoot;

    const nav = makeEl("nav", {}, "Cancel");
    const document = makeRoot([nav, outerHost]);

    const { handle, clicked } = resolveAndClickTopCandidate(document);

    expect(handle).not.toBeNull();
    expect(handle?.tier).toBe(3);
    expect(clicked).toBe(true);
    expect(innerButton.clicked).toBe(true);
  });

  it("resolves a light-DOM submit control via the existing path (no regression)", () => {
    const form = makeEl("form");
    const submitButton = makeEl("button", { type: "submit" }, "Submit");
    form.children.push(submitButton);
    const document = makeRoot([form]);

    const { handle, clicked } = resolveAndClickTopCandidate(document);

    expect(handle).not.toBeNull();
    expect(handle?.tier).toBe(3);
    expect(clicked).toBe(true);
    expect(submitButton.clicked).toBe(true);
  });

  it("returns null rather than a phantom handle when no submit control exists anywhere", () => {
    const nav = makeEl("nav", {}, "Back");
    const cancel = makeEl("button", {}, "Cancel");
    const document = makeRoot([nav, cancel]);

    const { handle, clicked } = resolveAndClickTopCandidate(document);

    expect(handle).toBeNull();
    expect(clicked).toBe(false);
  });
});
