import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  buildHcaptchaCallbackCaptureScript,
  HCAPTCHA_CALLBACK_REGISTRY_GLOBAL,
} from "@/scraper/captcha-callback-capture";

/**
 * Evals the produced script text directly (as `Page.addInitScript` would
 * inject it) against a fake global scope where `window` self-references the
 * global object, mirroring how browsers expose `window`.
 */
function makeFakeWindow(): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  return sandbox;
}

function runScript(sandbox: Record<string, unknown>): void {
  vm.createContext(sandbox);
  vm.runInContext(buildHcaptchaCallbackCaptureScript(), sandbox);
}

describe("buildHcaptchaCallbackCaptureScript", () => {
  it("captures the render-config callback when hcaptcha.js loads after the init script", () => {
    const sandbox = makeFakeWindow();
    runScript(sandbox);

    const callback = (): void => undefined;
    (sandbox.window as Record<string, unknown>).hcaptcha = {
      render: (_container: string, config: { sitekey: string; callback: () => void }) => {
        expect(config.callback).toBe(callback);
        return "widget-1";
      },
    };

    const hcaptcha = (sandbox.window as Record<string, unknown>).hcaptcha as {
      render: (container: string, config: Record<string, unknown>) => string;
    };
    const widgetId = hcaptcha.render("h-captcha", { sitekey: "site-a", callback });

    const registry = (sandbox.window as Record<string, unknown>)[
      HCAPTCHA_CALLBACK_REGISTRY_GLOBAL
    ] as Record<string, { sitekey: string; widgetId: string; callback: () => void }>;
    expect(widgetId).toBe("widget-1");
    expect(registry["site-a::widget-1"]).toEqual({
      sitekey: "site-a",
      widgetId: "widget-1",
      callback,
    });
  });

  it("captures the callback when window.hcaptcha already exists before the init script runs", () => {
    const sandbox = makeFakeWindow();
    const callback = (): void => undefined;
    (sandbox.window as Record<string, unknown>).hcaptcha = {
      render: (_container: string, config: Record<string, unknown>) => {
        void config;
        return "widget-2";
      },
    };

    runScript(sandbox);

    const hcaptcha = (sandbox.window as Record<string, unknown>).hcaptcha as {
      render: (container: string, config: Record<string, unknown>) => string;
    };
    hcaptcha.render("h-captcha", { sitekey: "site-b", callback });

    const registry = (sandbox.window as Record<string, unknown>)[
      HCAPTCHA_CALLBACK_REGISTRY_GLOBAL
    ] as Record<string, { sitekey: string; widgetId: string; callback: () => void }>;
    expect(registry["site-b::widget-2"]).toEqual({
      sitekey: "site-b",
      widgetId: "widget-2",
      callback,
    });
  });

  it("keys distinct widgets on the same page separately", () => {
    const sandbox = makeFakeWindow();
    runScript(sandbox);

    const callbackOne = (): void => undefined;
    const callbackTwo = (): void => undefined;
    let nextId = 1;
    (sandbox.window as Record<string, unknown>).hcaptcha = {
      render: () => String(nextId++),
    };

    const hcaptcha = (sandbox.window as Record<string, unknown>).hcaptcha as {
      render: (container: string, config: Record<string, unknown>) => string;
    };
    hcaptcha.render("h-captcha-1", { sitekey: "site-c", callback: callbackOne });
    hcaptcha.render("h-captcha-2", { sitekey: "site-c", callback: callbackTwo });

    const registry = (sandbox.window as Record<string, unknown>)[
      HCAPTCHA_CALLBACK_REGISTRY_GLOBAL
    ] as Record<string, { callback: () => void }>;
    expect(registry["site-c::1"]?.callback).toBe(callbackOne);
    expect(registry["site-c::2"]?.callback).toBe(callbackTwo);
  });

  it("still returns the real widget id and never throws when render has no callback", () => {
    const sandbox = makeFakeWindow();
    runScript(sandbox);

    (sandbox.window as Record<string, unknown>).hcaptcha = {
      render: () => "widget-no-callback",
    };

    const hcaptcha = (sandbox.window as Record<string, unknown>).hcaptcha as {
      render: (container: string, config: Record<string, unknown>) => string;
    };
    const widgetId = hcaptcha.render("h-captcha", { sitekey: "site-d" });

    expect(widgetId).toBe("widget-no-callback");
    const registry = (sandbox.window as Record<string, unknown>)[
      HCAPTCHA_CALLBACK_REGISTRY_GLOBAL
    ] as Record<string, unknown>;
    expect(Object.keys(registry)).toHaveLength(0);
  });

  it("never throws and leaves the registry empty when hcaptcha never appears on the page", () => {
    const sandbox = makeFakeWindow();

    expect(() => runScript(sandbox)).not.toThrow();

    const registry = (sandbox.window as Record<string, unknown>)[
      HCAPTCHA_CALLBACK_REGISTRY_GLOBAL
    ] as Record<string, unknown>;
    expect(registry).toEqual({});
  });

  it("is idempotent when the init script is injected more than once", () => {
    const sandbox = makeFakeWindow();
    runScript(sandbox);
    runScript(sandbox);

    const callback = (): void => undefined;
    (sandbox.window as Record<string, unknown>).hcaptcha = {
      render: () => "widget-once",
    };

    const hcaptcha = (sandbox.window as Record<string, unknown>).hcaptcha as {
      render: (container: string, config: Record<string, unknown>) => string;
    };
    hcaptcha.render("h-captcha", { sitekey: "site-e", callback });

    const registry = (sandbox.window as Record<string, unknown>)[
      HCAPTCHA_CALLBACK_REGISTRY_GLOBAL
    ] as Record<string, unknown>;
    expect(Object.keys(registry)).toHaveLength(1);
  });
});
