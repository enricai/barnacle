import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { submitCaptchaGatedForm } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Reproduces the recon report's "clean callback, zero site-host traffic"
 * fingerprint against `submitCaptchaGatedForm`'s explicit-submit fallback
 * (Signature A root cause): a ranked top pick that accepts a synthetic
 * click but wires no real handler — a phantom click — must not be reported
 * as a resolved submit when the caller opts into verification. Runs the
 * real `buildRankSubmitCandidatesExpr`/`buildClickByDeepIndexExpr` strings
 * via `node:vm`, mirroring the sibling disabled-candidate acceptance test's
 * technique, so this proves the primitives' real behavior rather than a
 * stubbed evaluate result.
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
      // Every synthetic click "succeeds" (marks clicked=true) but wires no
      // real handler — this is the phantom-click shape itself: the DOM
      // accepts the click, nothing downstream fires.
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

function makeFakeTarget(formEl: FakeEl): FrameTarget {
  const document = {
    body: undefined,
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

describe("flow-runner/submitCaptchaGatedForm — phantom-click verification on the explicit-submit fallback", () => {
  it("with no verification opt-in, reports success on the top pick's bare clicked:true (pre-existing non-verifying contract)", async () => {
    const form = makeEl("form", {}, "", {});
    appendChild(form, makeEl("div", { "data-sitekey": "10000000-ffff-ffff-ffff-000000000001" }));
    const topPick = appendChild(form, makeEl("button", { type: "submit" }, "Submit"));
    const runnerUp = appendChild(form, makeEl("div", { role: "button" }, "Submit Application"));

    const target = makeFakeTarget(form);
    const result = await submitCaptchaGatedForm(target);

    expect(result).toBe(true);
    expect(topPick.clicked).toBe(true);
    expect(runnerUp.clicked).toBe(false);
  });

  it("with verification opted in, retries the runner-up when the top pick's click shows zero observable effect", async () => {
    const form = makeEl("form", {}, "", {});
    appendChild(form, makeEl("div", { "data-sitekey": "10000000-ffff-ffff-ffff-000000000001" }));
    const topPick = appendChild(form, makeEl("button", { type: "submit" }, "Submit"));
    const runnerUp = appendChild(form, makeEl("div", { role: "button" }, "Submit Application"));

    const target = makeFakeTarget(form);
    const result = await submitCaptchaGatedForm(target, "h-captcha-response", {
      signalCounter: { n: 0 },
    });

    expect(result).toBe(true);
    expect(topPick.clicked).toBe(true);
    expect(runnerUp.clicked).toBe(true);
  });

  it("with verification opted in and no runner-up available, falls through to the form-level submit instead of crediting the phantom top pick", async () => {
    const form = makeEl("form", {}, "", {}) as FakeEl & {
      requestSubmit: () => void;
      requestSubmitCount: number;
    };
    form.requestSubmitCount = 0;
    form.requestSubmit = () => {
      form.requestSubmitCount += 1;
    };
    appendChild(form, makeEl("div", { "data-sitekey": "10000000-ffff-ffff-ffff-000000000001" }));
    const soleCandidate = appendChild(form, makeEl("button", { type: "submit" }, "Submit"));

    const target = makeFakeTarget(form);
    const result = await submitCaptchaGatedForm(target, "h-captcha-response", {
      signalCounter: { n: 0 },
    });

    expect(result).toBe(true);
    expect(soleCandidate.clicked).toBe(true);
    expect(form.requestSubmitCount).toBe(1);
  });
});
