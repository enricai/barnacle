import { describe, expect, it } from "vitest";

import { injectCaptchaTokenAndSubmit } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Exercises `injectCaptchaTokenAndSubmit`'s `target.evaluate` expression
 * against a fake DOM, mirroring `browser-click-expr.test.ts`'s technique of
 * running the real expression string via `new Function` rather than
 * hand-rolling a parallel re-implementation to assert against.
 */

class FakeInput {
  type = "";
  name = "";
  value = "";
  dispatched: string[] = [];
  form: FakeForm | null = null;
  dispatchEvent(ev: { type: string }): boolean {
    this.dispatched.push(ev.type);
    return true;
  }
  closest(selector: string): FakeForm | null {
    if (selector !== "form") throw new Error(`unsupported closest selector: ${selector}`);
    return this.form;
  }
}

class FakeForm {
  fields: FakeInput[] = [];
  hasSitekeyAnchor = false;
  submitCount = 0;
  appendChild(field: FakeInput): void {
    field.form = this;
    this.fields.push(field);
  }
  querySelector(selector: string): unknown {
    if (selector !== "[data-sitekey]") throw new Error(`unsupported form selector: ${selector}`);
    return this.hasSitekeyAnchor ? {} : null;
  }
  submit(): void {
    this.submitCount += 1;
  }
}

const FakeHTMLInputElement = {
  prototype: Object.defineProperty({}, "value", {
    set(this: FakeInput, v: string) {
      this.value = v;
    },
    get(this: FakeInput) {
      return this.value;
    },
  }),
};

class FakeEvent {
  type: string;
  bubbles: boolean;
  constructor(type: string, opts: { bubbles?: boolean } = {}) {
    this.type = type;
    this.bubbles = !!opts.bubbles;
  }
}

function makeFakeDocument(forms: FakeForm[], existingField?: FakeInput) {
  return {
    querySelector: (selector: string) => {
      const match = /^\[name="([^"]+)"\]$/.exec(selector);
      if (!match) throw new Error(`unsupported document selector: ${selector}`);
      return existingField?.name === match[1] ? existingField : null;
    },
    querySelectorAll: (selector: string) => {
      if (selector !== "form")
        throw new Error(`unsupported querySelectorAll selector: ${selector}`);
      return forms;
    },
    createElement: (tag: string) => {
      if (tag !== "input") throw new Error(`unsupported createElement tag: ${tag}`);
      return new FakeInput();
    },
  };
}

/** Runs `injectCaptchaTokenAndSubmit`'s built expression against the given fake DOM globals. */
function makeFakeTarget(globals: { document: ReturnType<typeof makeFakeDocument> }): FrameTarget {
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: null,
    evaluate: (async (expr: unknown) => {
      const fn = new Function(
        "document",
        "HTMLInputElement",
        "Event",
        `return ${expr as string}`
      ) as (doc: unknown, htmlInputEl: unknown, ev: unknown) => unknown;
      return fn(globals.document, FakeHTMLInputElement, FakeEvent);
    }) as FrameTarget["evaluate"],
    locator: () => ({ scope: "frame" as const }) as never,
    url: () => Promise.resolve("https://apply.example.com/application/abc-123"),
    title: () => Promise.resolve("application form"),
  };
}

describe("flow-runner/injectCaptchaTokenAndSubmit", () => {
  it("sets an existing response field to the token and submits its form exactly once", async () => {
    const form = new FakeForm();
    const field = new FakeInput();
    field.name = "h-captcha-response";
    form.appendChild(field);

    const target = makeFakeTarget({ document: makeFakeDocument([form], field) });

    const result = await injectCaptchaTokenAndSubmit(target, "solved-token-abc");

    expect(field.value).toBe("solved-token-abc");
    expect(field.dispatched).toEqual(["change"]);
    expect(form.submitCount).toBe(1);
    expect(result).toEqual({ injected: true, submitted: true });
  });

  it("uses the configured response field name and honors it over the h-captcha default", async () => {
    const form = new FakeForm();
    const field = new FakeInput();
    field.name = "g-recaptcha-response";
    form.appendChild(field);

    const target = makeFakeTarget({ document: makeFakeDocument([form], field) });

    const result = await injectCaptchaTokenAndSubmit(
      target,
      "solved-token-xyz",
      "g-recaptcha-response"
    );

    expect(field.value).toBe("solved-token-xyz");
    expect(form.submitCount).toBe(1);
    expect(result).toEqual({ injected: true, submitted: true });
  });

  it("creates a missing response field on the form carrying the widget anchor, not an earlier unrelated form", async () => {
    const headerSearchForm = new FakeForm();
    const applicationForm = new FakeForm();
    applicationForm.hasSitekeyAnchor = true;

    const target = makeFakeTarget({
      document: makeFakeDocument([headerSearchForm, applicationForm]),
    });

    const result = await injectCaptchaTokenAndSubmit(target, "solved-token-created");

    expect(headerSearchForm.fields).toHaveLength(0);
    expect(applicationForm.fields).toHaveLength(1);
    expect(applicationForm.fields[0]?.value).toBe("solved-token-created");
    expect(applicationForm.fields[0]?.dispatched).toEqual(["change"]);
    expect(applicationForm.submitCount).toBe(1);
    expect(headerSearchForm.submitCount).toBe(0);
    expect(result).toEqual({ injected: true, submitted: true });
  });

  it("reports no-op when there is no form to attach a freshly created field to", async () => {
    const target = makeFakeTarget({ document: makeFakeDocument([]) });

    const result = await injectCaptchaTokenAndSubmit(target, "solved-token-orphan");

    expect(result).toEqual({ injected: false, submitted: false });
  });

  it("injects into an existing field with no enclosing form without attempting to submit", async () => {
    const field = new FakeInput();
    field.name = "h-captcha-response";

    const target = makeFakeTarget({ document: makeFakeDocument([], field) });

    const result = await injectCaptchaTokenAndSubmit(target, "solved-token-formless");

    expect(field.value).toBe("solved-token-formless");
    expect(field.dispatched).toEqual(["change"]);
    expect(result).toEqual({ injected: true, submitted: false });
  });
});
