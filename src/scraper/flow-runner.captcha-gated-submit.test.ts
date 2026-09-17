import { describe, expect, it } from "vitest";

import { submitCaptchaGatedForm } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Exercises `submitCaptchaGatedForm`'s `target.evaluate` expression against a
 * fake DOM, mirroring `flow-runner.captcha-inject-submit.test.ts`'s technique
 * of running the real expression string via `new Function`.
 */

class FakeField {
  name: string;
  form: FakeForm | null = null;
  constructor(name: string) {
    this.name = name;
  }
  closest(selector: string): FakeForm | null {
    if (selector !== "form") throw new Error(`unsupported closest selector: ${selector}`);
    return this.form;
  }
}

class FakeForm {
  requestSubmitCount = 0;
  submitCount = 0;
  hasRequestSubmit: boolean;
  hasSitekey: boolean;
  constructor(opts: { hasRequestSubmit: boolean; hasSitekey?: boolean }) {
    this.hasRequestSubmit = opts.hasRequestSubmit;
    this.hasSitekey = opts.hasSitekey ?? false;
    if (this.hasRequestSubmit) {
      (this as unknown as { requestSubmit: () => void }).requestSubmit = () => {
        this.requestSubmitCount += 1;
      };
    }
  }
  querySelector(selector: string): true | null {
    if (selector !== "[data-sitekey]") throw new Error(`unsupported form selector: ${selector}`);
    return this.hasSitekey ? true : null;
  }
  submit(): void {
    this.submitCount += 1;
  }
}

function makeFakeTarget(opts: { field?: FakeField | null; forms?: FakeForm[] }): FrameTarget {
  const field = opts.field ?? null;
  const forms = opts.forms ?? [];
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: null,
    evaluate: (async (expr: unknown) => {
      const document = {
        querySelector: (selector: string) => {
          const match = /^\[name="([^"]+)"\]$/.exec(selector);
          if (!match) throw new Error(`unsupported document selector: ${selector}`);
          return field?.name === match[1] ? field : null;
        },
        querySelectorAll: (selector: string) => {
          if (selector !== "form") throw new Error(`unsupported document selector: ${selector}`);
          return forms;
        },
      };
      const fn = new Function("document", `return ${expr as string}`) as (doc: unknown) => unknown;
      return fn(document);
    }) as FrameTarget["evaluate"],
    locator: () => ({ scope: "frame" as const }) as never,
    url: () => Promise.resolve("https://apply.example.com/application/abc-123"),
    title: () => Promise.resolve("application form"),
  };
}

describe("flow-runner/submitCaptchaGatedForm", () => {
  it("prefers form.requestSubmit() when it's available on the resolved form, and reports found=true", async () => {
    const form = new FakeForm({ hasRequestSubmit: true });
    const field = new FakeField("h-captcha-response");
    field.form = form;

    await expect(submitCaptchaGatedForm(makeFakeTarget({ field }))).resolves.toBe(true);

    expect(form.requestSubmitCount).toBe(1);
    expect(form.submitCount).toBe(0);
  });

  it("falls back to form.submit() when requestSubmit isn't present on the form", async () => {
    const form = new FakeForm({ hasRequestSubmit: false });
    const field = new FakeField("h-captcha-response");
    field.form = form;

    await expect(submitCaptchaGatedForm(makeFakeTarget({ field }))).resolves.toBe(true);

    expect(form.submitCount).toBe(1);
  });

  it("honors a configured response field name over the h-captcha default", async () => {
    const form = new FakeForm({ hasRequestSubmit: true });
    const field = new FakeField("g-recaptcha-response");
    field.form = form;

    await expect(
      submitCaptchaGatedForm(makeFakeTarget({ field }), "g-recaptcha-response")
    ).resolves.toBe(true);

    expect(form.requestSubmitCount).toBe(1);
  });

  it("falls back to the sitekey-anchored form and submits it when no named field exists but a form does", async () => {
    const decoyForm = new FakeForm({ hasRequestSubmit: true });
    const sitekeyForm = new FakeForm({ hasRequestSubmit: true, hasSitekey: true });

    await expect(
      submitCaptchaGatedForm(makeFakeTarget({ field: null, forms: [decoyForm, sitekeyForm] }))
    ).resolves.toBe(true);

    expect(sitekeyForm.requestSubmitCount).toBe(1);
    expect(decoyForm.requestSubmitCount).toBe(0);
  });

  it("falls back to the sole form when no named field exists and no form carries a sitekey", async () => {
    const soleForm = new FakeForm({ hasRequestSubmit: true });

    await expect(
      submitCaptchaGatedForm(makeFakeTarget({ field: null, forms: [soleForm] }))
    ).resolves.toBe(true);

    expect(soleForm.requestSubmitCount).toBe(1);
  });

  it("resolves to false and submits nothing when the page has no form at all", async () => {
    await expect(submitCaptchaGatedForm(makeFakeTarget({ field: null, forms: [] }))).resolves.toBe(
      false
    );
  });

  it("resolves to false when the field exists but has since been detached from any form, and no other form is on the page", async () => {
    const field = new FakeField("h-captcha-response");
    field.form = null;

    await expect(submitCaptchaGatedForm(makeFakeTarget({ field, forms: [] }))).resolves.toBe(false);
  });
});
