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
  constructor(opts: { hasRequestSubmit: boolean }) {
    this.hasRequestSubmit = opts.hasRequestSubmit;
    if (this.hasRequestSubmit) {
      (this as unknown as { requestSubmit: () => void }).requestSubmit = () => {
        this.requestSubmitCount += 1;
      };
    }
  }
  submit(): void {
    this.submitCount += 1;
  }
}

function makeFakeTarget(field: FakeField | null): FrameTarget {
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
  it("prefers form.requestSubmit() when it's available on the resolved form", async () => {
    const form = new FakeForm({ hasRequestSubmit: true });
    const field = new FakeField("h-captcha-response");
    field.form = form;

    await submitCaptchaGatedForm(makeFakeTarget(field));

    expect(form.requestSubmitCount).toBe(1);
    expect(form.submitCount).toBe(0);
  });

  it("falls back to form.submit() when requestSubmit isn't present on the form", async () => {
    const form = new FakeForm({ hasRequestSubmit: false });
    const field = new FakeField("h-captcha-response");
    field.form = form;

    await submitCaptchaGatedForm(makeFakeTarget(field));

    expect(form.submitCount).toBe(1);
  });

  it("honors a configured response field name over the h-captcha default", async () => {
    const form = new FakeForm({ hasRequestSubmit: true });
    const field = new FakeField("g-recaptcha-response");
    field.form = form;

    await submitCaptchaGatedForm(makeFakeTarget(field), "g-recaptcha-response");

    expect(form.requestSubmitCount).toBe(1);
  });

  it("no-ops when there is no field to resolve a form from", async () => {
    await expect(submitCaptchaGatedForm(makeFakeTarget(null))).resolves.toBeUndefined();
  });
});
