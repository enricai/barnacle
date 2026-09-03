import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import {
  buildHcaptchaCallbackCaptureScript,
  HCAPTCHA_CALLBACK_REGISTRY_GLOBAL,
  installHcaptchaCallbackCaptureOnAllFrames,
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

  it("wraps an already-assigned unwrapped hcaptcha.render even when the registry global pre-exists", () => {
    const sandbox = makeFakeWindow();
    (sandbox.window as Record<string, unknown>)[HCAPTCHA_CALLBACK_REGISTRY_GLOBAL] = {};

    const render = (): string => "widget-late";
    (sandbox.window as Record<string, unknown>).hcaptcha = { render };

    runScript(sandbox);

    const hcaptcha = (sandbox.window as Record<string, unknown>).hcaptcha as {
      render: { __barnacleWrapped?: boolean };
    };
    expect(hcaptcha.render.__barnacleWrapped).toBe(true);
  });

  it("re-wraps the current window.hcaptcha via the getter branch when render is reassigned after the setter already wrapped it once", () => {
    const sandbox = makeFakeWindow();
    runScript(sandbox);

    const originalRender = (): string => "widget-original";
    (sandbox.window as Record<string, unknown>).hcaptcha = { render: originalRender };

    const hcaptchaAfterSetter = (sandbox.window as Record<string, unknown>).hcaptcha as {
      render: { __barnacleWrapped?: boolean };
    };
    expect(hcaptchaAfterSetter.render.__barnacleWrapped).toBe(true);

    const freshUnwrappedRender = (): string => "widget-retampered";
    hcaptchaAfterSetter.render = freshUnwrappedRender as unknown as {
      __barnacleWrapped?: boolean;
    };
    expect(hcaptchaAfterSetter.render).toBe(freshUnwrappedRender);

    runScript(sandbox);

    const hcaptchaAfterRewrap = (sandbox.window as Record<string, unknown>).hcaptcha as {
      render: { __barnacleWrapped?: boolean } & ((
        container: string,
        config: Record<string, unknown>
      ) => string);
    };
    expect(hcaptchaAfterRewrap.render.__barnacleWrapped).toBe(true);
    expect(hcaptchaAfterRewrap.render).not.toBe(freshUnwrappedRender);

    const callback = (): void => undefined;
    const widgetId = hcaptchaAfterRewrap.render("h-captcha", {
      sitekey: "site-f",
      callback,
    });

    expect(widgetId).toBe("widget-retampered");
    const registry = (sandbox.window as Record<string, unknown>)[
      HCAPTCHA_CALLBACK_REGISTRY_GLOBAL
    ] as Record<string, { sitekey: string; widgetId: string; callback: () => void }>;
    expect(registry["site-f::widget-retampered"]).toEqual({
      sitekey: "site-f",
      widgetId: "widget-retampered",
      callback,
    });
  });
});

describe("installHcaptchaCallbackCaptureOnAllFrames", () => {
  /**
   * Fakes the CDP `session.on`/`send` surface {@link CDPSessionLike} exposes,
   * capturing registered handlers so the test can fire a `Page.frameAttached`
   * event the way the real CDP session would.
   */
  function makeFakeSession(): {
    session: {
      send: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      off: ReturnType<typeof vi.fn>;
    };
    handlers: Record<string, (params: unknown) => void>;
  } {
    const handlers: Record<string, (params: unknown) => void> = {};
    const session = {
      send: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, handler: (params: unknown) => void) => {
        handlers[event] = handler;
      }),
      off: vi.fn(),
    };
    return { session, handlers };
  }

  it("evaluates the capture script into a newly attached child frame specifically, not the main frame", () => {
    const { session, handlers } = makeFakeSession();
    const mainFrameEvaluate = vi.fn().mockResolvedValue(undefined);
    const childFrameEvaluate = vi.fn().mockResolvedValue(undefined);
    const frames: Record<string, { evaluate: ReturnType<typeof vi.fn> }> = {
      "main-frame": { evaluate: mainFrameEvaluate },
      "child-frame": { evaluate: childFrameEvaluate },
    };
    const page = {
      getSessionForFrame: vi.fn().mockReturnValue(session),
      mainFrameId: vi.fn().mockReturnValue("main-frame"),
      frameForId: vi.fn((frameId: string) => frames[frameId]),
    } as unknown as Page;

    installHcaptchaCallbackCaptureOnAllFrames(page);

    expect(page.getSessionForFrame).toHaveBeenCalledWith("main-frame");
    expect(session.on).toHaveBeenCalledWith("Page.frameAttached", expect.any(Function));
    expect(session.on).toHaveBeenCalledWith("Page.frameNavigated", expect.any(Function));

    handlers["Page.frameAttached"]?.({ frameId: "child-frame" });

    expect(page.frameForId).toHaveBeenCalledWith("child-frame");
    expect(childFrameEvaluate).toHaveBeenCalledWith(buildHcaptchaCallbackCaptureScript());
    expect(mainFrameEvaluate).not.toHaveBeenCalled();
  });

  it("evaluates the capture script into the frame named by a frameNavigated event", () => {
    const { session, handlers } = makeFakeSession();
    const navigatedFrameEvaluate = vi.fn().mockResolvedValue(undefined);
    const frames: Record<string, { evaluate: ReturnType<typeof vi.fn> }> = {
      "main-frame": { evaluate: vi.fn().mockResolvedValue(undefined) },
      "navigated-frame": { evaluate: navigatedFrameEvaluate },
    };
    const page = {
      getSessionForFrame: vi.fn().mockReturnValue(session),
      mainFrameId: vi.fn().mockReturnValue("main-frame"),
      frameForId: vi.fn((frameId: string) => frames[frameId]),
    } as unknown as Page;

    installHcaptchaCallbackCaptureOnAllFrames(page);
    handlers["Page.frameNavigated"]?.({ frame: { id: "navigated-frame" } });

    expect(page.frameForId).toHaveBeenCalledWith("navigated-frame");
    expect(navigatedFrameEvaluate).toHaveBeenCalledWith(buildHcaptchaCallbackCaptureScript());
  });

  it("never branches on siteId/plugin identity — the source is frame-agnostic", () => {
    const source = fs.readFileSync(path.join(__dirname, "captcha-callback-capture.ts"), "utf8");
    expect(source).not.toMatch(/siteId|pluginName|plugin\.meta/i);
  });
});
