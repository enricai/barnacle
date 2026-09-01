import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { injectCaptchaTokenAndSubmit } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Runs `injectCaptchaTokenAndSubmit`'s real `target.evaluate` expression
 * string against a genuine happy-dom `Window`/`Document` (mirroring
 * `flow-runner.frame-primitives.test.ts`'s n+16 real-DOM suite and
 * `flow-runner.oopif-wizard-exit-guard.test.ts`'s fake-`FrameTarget`
 * harness), rather than `flow-runner.captcha-inject-submit.test.ts`'s
 * hand-rolled `FakeInput`/`FakeForm` classes — so a break in the property
 * descriptor walk, `closest("form")` traversal, or event bubbling would
 * fail here even if the hand-rolled fakes happened to still agree with it.
 */

function makeRealDomTarget(window: Window): FrameTarget {
  const document = window.document;
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: null,
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      const fn = new Function(
        "document",
        "HTMLInputElement",
        "Event",
        `return (${expr as string})`
      ) as (doc: unknown, htmlInputEl: unknown, ev: unknown) => unknown;
      return fn(document, window.HTMLInputElement, window.Event);
    }) as FrameTarget["evaluate"],
    locator: () => ({ scope: "frame" as const }) as never,
    url: () => Promise.resolve("https://apply.example.com/application/abc-123"),
    title: () => Promise.resolve("application form"),
  };
}

describe("flow-runner/injectCaptchaTokenAndSubmit — real happy-dom DOM", () => {
  it("sets the h-captcha-response field to the token and submits its form exactly once", async () => {
    const window = new Window({ url: "https://apply.example.com/application/abc-123" });
    const document = window.document;
    document.body.innerHTML = `
      <form id="application">
        <div data-sitekey="fake-sitekey"></div>
        <input type="hidden" name="h-captcha-response" value="" />
      </form>
    `;
    const form = document.getElementById("application") as unknown as {
      submit: () => void;
    };
    const submitSpy = vi.fn();
    form.submit = submitSpy;

    const field = document.querySelector('[name="h-captcha-response"]') as unknown as {
      value: string;
      addEventListener: (type: string, listener: () => void) => void;
    };
    const changeListener = vi.fn();
    field.addEventListener("change", changeListener);

    const target = makeRealDomTarget(window);

    const result = await injectCaptchaTokenAndSubmit(target, "solved-token-abc");

    expect(target.evaluate).toHaveBeenCalledTimes(3);
    expect(field.value).toBe("solved-token-abc");
    expect(changeListener).toHaveBeenCalledTimes(1);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ injected: true, submitted: true });
  });

  it("creates a hidden response field on the form carrying the sitekey anchor and submits it once", async () => {
    const window = new Window({ url: "https://apply.example.com/application/abc-123" });
    const document = window.document;
    document.body.innerHTML = `
      <form id="header-search"></form>
      <form id="application">
        <div data-sitekey="fake-sitekey"></div>
      </form>
    `;
    const headerForm = document.getElementById("header-search") as unknown as {
      submit: () => void;
    };
    const applicationForm = document.getElementById("application") as unknown as {
      submit: () => void;
    };
    const headerSubmitSpy = vi.fn();
    const applicationSubmitSpy = vi.fn();
    headerForm.submit = headerSubmitSpy;
    applicationForm.submit = applicationSubmitSpy;

    const target = makeRealDomTarget(window);

    const result = await injectCaptchaTokenAndSubmit(target, "solved-token-created");

    const field = document.querySelector('[name="h-captcha-response"]') as unknown as {
      value: string;
      parentElement: { id: string };
    };
    expect(field).not.toBeNull();
    expect(field.value).toBe("solved-token-created");
    expect(field.parentElement.id).toBe("application");
    expect(applicationSubmitSpy).toHaveBeenCalledTimes(1);
    expect(headerSubmitSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ injected: true, submitted: true });
  });

  it("honors a configured response field name over the h-captcha default", async () => {
    const window = new Window({ url: "https://apply.example.com/application/abc-123" });
    const document = window.document;
    document.body.innerHTML = `
      <form id="application">
        <input type="hidden" name="g-recaptcha-response" value="" />
      </form>
    `;
    const form = document.getElementById("application") as unknown as { submit: () => void };
    const submitSpy = vi.fn();
    form.submit = submitSpy;

    const target = makeRealDomTarget(window);

    const result = await injectCaptchaTokenAndSubmit(
      target,
      "solved-token-xyz",
      "g-recaptcha-response"
    );

    const field = document.querySelector('[name="g-recaptcha-response"]') as unknown as {
      value: string;
    };
    expect(field.value).toBe("solved-token-xyz");
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ injected: true, submitted: true });
  });

  it("reports no-op when there is no form to attach a freshly created field to", async () => {
    const window = new Window({ url: "https://apply.example.com/application/abc-123" });
    const target = makeRealDomTarget(window);

    const result = await injectCaptchaTokenAndSubmit(target, "solved-token-orphan");

    expect(result).toEqual({ injected: false, submitted: false });
  });

  it("resolves with submitted: true even when the dispatch and submit evaluates reject because a navigation tore down the execution context", async () => {
    const window = new Window({ url: "https://apply.example.com/application/abc-123" });
    const document = window.document;
    document.body.innerHTML = `
      <form id="application">
        <div data-sitekey="fake-sitekey"></div>
        <input type="hidden" name="h-captcha-response" value="" />
      </form>
    `;

    const target = makeRealDomTarget(window);
    const realEvaluate = target.evaluate as unknown as ReturnType<typeof vi.fn>;
    const injectImplementation = realEvaluate.getMockImplementation() as (expr: unknown) => unknown;
    let callCount = 0;
    realEvaluate.mockImplementation(async (expr: unknown) => {
      callCount += 1;
      if (callCount > 1) {
        throw new Error("Execution context was destroyed");
      }
      return injectImplementation(expr);
    });

    await expect(injectCaptchaTokenAndSubmit(target, "solved-token-abc")).resolves.toEqual({
      injected: true,
      submitted: true,
    });
    expect(target.evaluate).toHaveBeenCalledTimes(3);
  });

  it("resolves with injected: true and still submits when only the change-dispatch evaluate rejects because a navigation tore down the execution context", async () => {
    const window = new Window({ url: "https://apply.example.com/application/abc-123" });
    const document = window.document;
    document.body.innerHTML = `
      <form id="application">
        <div data-sitekey="fake-sitekey"></div>
        <input type="hidden" name="h-captcha-response" value="" />
      </form>
    `;
    const form = document.getElementById("application") as unknown as {
      submit: () => void;
    };
    const submitSpy = vi.fn();
    form.submit = submitSpy;

    const target = makeRealDomTarget(window);
    const realEvaluate = target.evaluate as unknown as ReturnType<typeof vi.fn>;
    const injectImplementation = realEvaluate.getMockImplementation() as (expr: unknown) => unknown;
    let callCount = 0;
    realEvaluate.mockImplementation(async (expr: unknown) => {
      callCount += 1;
      if (callCount === 2) {
        throw new Error("Execution context was destroyed");
      }
      return injectImplementation(expr);
    });

    const field = document.querySelector('[name="h-captcha-response"]') as unknown as {
      value: string;
    };

    await expect(injectCaptchaTokenAndSubmit(target, "solved-token-abc")).resolves.toEqual({
      injected: true,
      submitted: true,
    });
    expect(field.value).toBe("solved-token-abc");
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(target.evaluate).toHaveBeenCalledTimes(3);
  });
});
