import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { HCAPTCHA_CALLBACK_REGISTRY_GLOBAL } from "@/scraper/captcha-callback-capture";
import { injectCaptchaTokenAndSubmit } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Runs `injectCaptchaTokenAndSubmit`'s real `target.evaluate` expression
 * strings against a genuine happy-dom `Window`/`Document` (mirroring
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
        "window",
        `return (${expr as string})`
      ) as (doc: unknown, htmlInputEl: unknown, ev: unknown, win: unknown) => unknown;
      return fn(document, window.HTMLInputElement, window.Event, window);
    }) as FrameTarget["evaluate"],
    locator: () => ({ scope: "frame" as const }) as never,
    url: () => Promise.resolve("https://apply.example.com/application/abc-123"),
    title: () => Promise.resolve("application form"),
  };
}

describe("flow-runner/injectCaptchaTokenAndSubmit — real happy-dom DOM", () => {
  it("sets the h-captcha-response field to the token without submitting its form", async () => {
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

    // precheck, late-install, late-precheck, set-value, dispatch-change
    expect(target.evaluate).toHaveBeenCalledTimes(5);
    expect(field.value).toBe("solved-token-abc");
    expect(changeListener).toHaveBeenCalledTimes(1);
    expect(submitSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ injected: true, hasForm: true, callbackDiscovered: false });
  });

  it("creates a hidden response field on the form carrying the sitekey anchor without submitting it", async () => {
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
    expect(applicationSubmitSpy).not.toHaveBeenCalled();
    expect(headerSubmitSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ injected: true, hasForm: true, callbackDiscovered: false });
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
    expect(submitSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ injected: true, hasForm: true, callbackDiscovered: false });
  });

  it("reports no-op when there is no form to attach a freshly created field to", async () => {
    const window = new Window({ url: "https://apply.example.com/application/abc-123" });
    const target = makeRealDomTarget(window);

    const result = await injectCaptchaTokenAndSubmit(target, "solved-token-orphan");

    expect(result).toEqual({ injected: false, hasForm: false, callbackDiscovered: false });
  });

  it("resolves with injected: true even when the value-set evaluate rejects because assigning the field navigated and tore down the execution context", async () => {
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
      if (callCount === 2) {
        throw new Error("Execution context was destroyed");
      }
      return injectImplementation(expr);
    });

    await expect(injectCaptchaTokenAndSubmit(target, "solved-token-abc")).resolves.toEqual({
      injected: true,
      hasForm: true,
      callbackDiscovered: false,
    });
    // precheck, late-install, late-precheck, set-value, dispatch-change
    expect(target.evaluate).toHaveBeenCalledTimes(5);
  });

  it("resolves with injected: true when only the change-dispatch evaluate rejects because a navigation tore down the execution context", async () => {
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
      if (callCount === 3) {
        throw new Error("Execution context was destroyed");
      }
      return injectImplementation(expr);
    });

    const field = document.querySelector('[name="h-captcha-response"]') as unknown as {
      value: string;
    };

    await expect(injectCaptchaTokenAndSubmit(target, "solved-token-abc")).resolves.toEqual({
      injected: true,
      hasForm: true,
      callbackDiscovered: false,
    });
    expect(field.value).toBe("solved-token-abc");
    expect(submitSpy).not.toHaveBeenCalled();
    // precheck, late-install, late-precheck, set-value, dispatch-change
    expect(target.evaluate).toHaveBeenCalledTimes(5);
  });

  it("invokes the widget's registered data-callback with the token, letting it append its own field", async () => {
    const window = new Window({ url: "https://apply.example.com/application/abc-123" });
    const document = window.document;
    document.body.innerHTML = `
      <form id="application">
        <div data-sitekey="fake-sitekey" data-callback="onCaptchaSolved"></div>
        <input type="hidden" name="h-captcha-response" value="" />
      </form>
    `;
    const form = document.getElementById("application") as unknown as {
      submit: () => void;
      appendChild: (node: unknown) => void;
    };
    const submitSpy = vi.fn();
    form.submit = submitSpy;

    (window as unknown as Record<string, unknown>).onCaptchaSolved = (token: string) => {
      const extraField = document.createElement("input");
      extraField.type = "hidden";
      extraField.name = "extra-companion-field";
      extraField.value = token;
      form.appendChild(extraField);
    };

    const target = makeRealDomTarget(window);

    const result = await injectCaptchaTokenAndSubmit(target, "solved-token-callback");

    const extraField = document.querySelector('[name="extra-companion-field"]') as unknown as {
      value: string;
    };
    expect(extraField).not.toBeNull();
    expect(extraField.value).toBe("solved-token-callback");
    expect(submitSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ injected: true, hasForm: true, callbackDiscovered: true });
  });

  it("invokes a callback captured from a programmatic hcaptcha.render({ callback }) call when no data-callback attribute exists", async () => {
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
      appendChild: (node: unknown) => void;
    };
    const submitSpy = vi.fn();
    form.submit = submitSpy;

    const capturedCallback = (token: string): void => {
      const extraField = document.createElement("input");
      extraField.type = "hidden";
      extraField.name = "extra-companion-field";
      extraField.value = token;
      form.appendChild(extraField);
    };
    (window as unknown as Record<string, unknown>)[HCAPTCHA_CALLBACK_REGISTRY_GLOBAL] = {
      "fake-sitekey::1": { sitekey: "fake-sitekey", widgetId: 1, callback: capturedCallback },
    };

    const target = makeRealDomTarget(window);

    const result = await injectCaptchaTokenAndSubmit(target, "solved-token-captured");

    const extraField = document.querySelector('[name="extra-companion-field"]') as unknown as {
      value: string;
    };
    expect(extraField).not.toBeNull();
    expect(extraField.value).toBe("solved-token-captured");
    expect(submitSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ injected: true, hasForm: true, callbackDiscovered: true });
  });

  it("prefers hcaptcha.execute(widgetId) over the bare captured callback when the real widgetId and execute are both known", async () => {
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
      appendChild: (node: unknown) => void;
    };
    const submitSpy = vi.fn();
    form.submit = submitSpy;

    const directInvoke = vi.fn();
    const capturedCallback = (token: string): void => {
      directInvoke(token);
      const extraField = document.createElement("input");
      extraField.type = "hidden";
      extraField.name = "extra-companion-field";
      extraField.value = token;
      form.appendChild(extraField);
    };
    (window as unknown as Record<string, unknown>)[HCAPTCHA_CALLBACK_REGISTRY_GLOBAL] = {
      "fake-sitekey::7": { sitekey: "fake-sitekey", widgetId: 7, callback: capturedCallback },
    };

    // Mirrors hCaptcha's own execute/verify cycle: execute() is what actually
    // resolves and invokes the widget's registered callback, so a code path
    // that bypasses execute() and calls the captured callback directly would
    // never touch this mock at all.
    const execute = vi.fn().mockImplementation((widgetId: number) => {
      capturedCallback(`verified-via-execute-${widgetId}`);
    });
    (window as unknown as Record<string, unknown>).hcaptcha = { execute };

    const target = makeRealDomTarget(window);

    const result = await injectCaptchaTokenAndSubmit(target, "solved-token-captured");

    expect(execute).toHaveBeenCalledWith(7);
    expect(directInvoke).toHaveBeenCalledWith("verified-via-execute-7");
    const extraField = document.querySelector('[name="extra-companion-field"]') as unknown as {
      value: string;
    };
    expect(extraField.value).toBe("verified-via-execute-7");
    expect(submitSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ injected: true, hasForm: true, callbackDiscovered: true });
  });

  it("falls back to the set-value+dispatch-change path when no data-callback is discoverable", async () => {
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

    const result = await injectCaptchaTokenAndSubmit(target, "solved-token-nocallback");

    expect(field.value).toBe("solved-token-nocallback");
    expect(changeListener).toHaveBeenCalledTimes(1);
    expect(submitSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ injected: true, hasForm: true, callbackDiscovered: false });
  });

  it("distinguishes callbackDiscovered: false from the success shape when neither a data-callback attribute nor a matching render-config entry exists", async () => {
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

    // A registry that exists (a render call happened elsewhere on the page)
    // but has no entry for this widget's sitekey — the discovery walk must
    // still report false rather than mistaking "registry present" for
    // "callback found".
    (window as unknown as Record<string, unknown>)[HCAPTCHA_CALLBACK_REGISTRY_GLOBAL] = {
      "other-sitekey::7": { sitekey: "other-sitekey", widgetId: 7, callback: vi.fn() },
    };

    const target = makeRealDomTarget(window);

    const result = await injectCaptchaTokenAndSubmit(target, "solved-token-no-match");

    expect(result).toEqual({ injected: true, hasForm: true, callbackDiscovered: false });
    expect(result).not.toMatchObject({ callbackDiscovered: true });
    expect(submitSpy).not.toHaveBeenCalled();
  });
});
