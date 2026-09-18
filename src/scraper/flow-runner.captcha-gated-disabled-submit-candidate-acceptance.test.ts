import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { submitCaptchaGatedForm } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Reproduces the report's Root Cause A fingerprint directly against
 * `submitCaptchaGatedForm`'s real `buildRankSubmitCandidatesExpr` /
 * `buildClickByDeepIndexExpr` fallback path (the primitives a clean
 * captcha callback with no matchable inject falls through to): a fake DOM
 * whose only submit-shaped candidate at fallback time is natively
 * disabled must never earn a phantom `clicked: true`, and the function
 * must fall through to the next enabled candidate (or the form-level
 * fallback) instead. Runs the generated expression strings for real via
 * `node:vm`, mirroring `submit-control.test.ts`'s technique, rather than
 * stubbing `target.evaluate`'s return value — a stub would prove the
 * caller's handling of a canned result, not that the rank/click
 * primitives themselves veto the disabled candidate.
 */

interface FakeEl {
  tagName: string;
  attrs: Record<string, string>;
  textContent: string;
  children: FakeEl[];
  shadowRoot: null;
  rect: { width: number; height: number };
  computedStyle: { display: string; visibility: string };
  disabled: boolean;
  clicked: boolean;
  getAttribute(name: string): string | null;
  querySelector(selector: string): FakeEl | null;
  querySelectorAll(selector: "*"): FakeEl[];
  getBoundingClientRect(): { width: number; height: number };
  focus(): void;
  dispatchEvent(evt: { type: string }): void;
}

function makeEl(
  tagName: string,
  attrs: Record<string, string> = {},
  textContent = "",
  opts: { disabled?: boolean } = {}
): FakeEl {
  const el: FakeEl = {
    tagName: tagName.toUpperCase(),
    attrs,
    textContent,
    children: [],
    shadowRoot: null,
    rect: { width: 100, height: 20 },
    computedStyle: { display: "block", visibility: "visible" },
    disabled: opts.disabled ?? false,
    clicked: false,
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? (attrs[name] ?? null) : null;
    },
    querySelector(selector) {
      const match = /^\[([\w-]+)\]$/.exec(selector);
      if (!match) throw new Error(`unsupported form querySelector: ${selector}`);
      const attrName = match[1] as string;
      const found = flatten(el.children).find((child) => Object.hasOwn(child.attrs, attrName));
      return found ?? null;
    },
    querySelectorAll() {
      return flatten(el.children);
    },
    getBoundingClientRect() {
      return el.rect;
    },
    focus() {},
    dispatchEvent(evt) {
      if (evt.type === "click") el.clicked = true;
    },
  };
  return el;
}

function flatten(children: FakeEl[]): FakeEl[] {
  const out: FakeEl[] = [];
  for (const child of children) {
    out.push(child);
    out.push(...flatten(child.children));
  }
  return out;
}

function appendChild(parent: FakeEl, child: FakeEl): FakeEl {
  parent.children.push(child);
  return child;
}

/**
 * Builds a `FrameTarget` whose `evaluate` runs the real generated expression
 * strings against a `document` supporting exactly the surface
 * `submitCaptchaGatedForm` and the rank/click primitives touch:
 * `querySelector('[name="..."]')` (named response field lookup, always
 * absent here — matches the report's invisible/callback-only widget),
 * `querySelectorAll("form")` (form resolution), and `querySelectorAll("*")`
 * (the deep traversal the rank/click primitives run against the whole
 * document).
 */
function makeFakeTarget(formEl: FakeEl): FrameTarget {
  const document = {
    querySelector(selector: string): null {
      const match = /^\[name="([^"]+)"\]$/.exec(selector);
      if (!match) throw new Error(`unsupported document querySelector: ${selector}`);
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === "form") return [formEl];
      if (selector === "*") return flatten(formEl.children);
      throw new Error(`unsupported document querySelectorAll: ${selector}`);
    },
  };
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: null,
    evaluate: (async (expr: unknown) => {
      return runInNewContext(expr as string, {
        document,
        getComputedStyle: (el: FakeEl) => el.computedStyle,
        Event: class {
          type: string;
          constructor(type: string) {
            this.type = type;
          }
        },
        console,
      });
    }) as FrameTarget["evaluate"],
    locator: () => ({ scope: "frame" as const }) as never,
    url: () => Promise.resolve("https://apply.example.com/application/abc-123"),
    title: () => Promise.resolve("application form"),
  };
}

describe("flow-runner/submitCaptchaGatedForm — disabled submit candidate at fallback time (Root Cause A acceptance)", () => {
  it("never reports a phantom click success when the sole sitekey-anchored submit candidate is disabled, and dispatches no click event", async () => {
    const form = makeEl("form", {}, "", {}) as FakeEl & {
      requestSubmit: () => void;
      requestSubmitCount: number;
    };
    form.requestSubmitCount = 0;
    form.requestSubmit = () => {
      form.requestSubmitCount += 1;
    };
    appendChild(form, makeEl("div", { "data-sitekey": "10000000-ffff-ffff-ffff-000000000001" }));
    const disabledSubmit = appendChild(
      form,
      makeEl("button", { type: "submit" }, "Submit", { disabled: true })
    );

    const target = makeFakeTarget(form);
    const result = await submitCaptchaGatedForm(target);

    // A form was found and something was attempted, but it MUST be the
    // form-level fallback (requestSubmit), never a phantom click on the
    // disabled control — this is the report's "clean callback, zero
    // real-click traffic" fingerprint, closed by the disabled veto.
    expect(result).toBe(true);
    expect(disabledSubmit.clicked).toBe(false);
    expect(form.requestSubmitCount).toBe(1);
  });

  it("skips a disabled top-tier candidate and clicks the next enabled (lower-tier) candidate instead", async () => {
    const form = makeEl("form", {}, "", {});
    appendChild(form, makeEl("div", { "data-sitekey": "10000000-ffff-ffff-ffff-000000000001" }));
    const disabledSubmit = appendChild(
      form,
      makeEl("button", { type: "submit" }, "Submit", { disabled: true })
    );
    const enabledFallback = appendChild(
      form,
      makeEl("div", { role: "button" }, "Submit Application")
    );

    const target = makeFakeTarget(form);
    const result = await submitCaptchaGatedForm(target);

    expect(result).toBe(true);
    expect(disabledSubmit.clicked).toBe(false);
    expect(enabledFallback.clicked).toBe(true);
  });
});
