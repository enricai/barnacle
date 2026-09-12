import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

// Hoist-safe mock so captcha-callback-capture.ts's own module-level
// getLogger call receives our stub — required because vitest mocks need to
// be registered before the module under test imports logging.ts.
const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({ getLogger: () => loggerStub }));

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
   * capturing registered handlers so the test can fire a `Target.attachedToTarget`
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

  function makePage(session: ReturnType<typeof makeFakeSession>["session"]): {
    page: Page;
    childSessions: Record<string, { send: ReturnType<typeof vi.fn> }>;
  } {
    const childSessions: Record<string, { send: ReturnType<typeof vi.fn> }> = {};
    const page = {
      getSessionForFrame: vi.fn().mockReturnValue(session),
      mainFrameId: vi.fn().mockReturnValue("main-frame"),
      getSessionById: vi.fn((id: string) => childSessions[id]),
    } as unknown as Page;
    return { page, childSessions };
  }

  it("registers the capture script on the main session via Page.addScriptToEvaluateOnNewDocument and enables target auto-attach", async () => {
    const { session } = makeFakeSession();
    const { page } = makePage(session);

    await installHcaptchaCallbackCaptureOnAllFrames(page);

    expect(page.getSessionForFrame).toHaveBeenCalledWith("main-frame");
    expect(session.send).toHaveBeenCalledWith("Page.addScriptToEvaluateOnNewDocument", {
      source: buildHcaptchaCallbackCaptureScript(),
    });
    expect(session.send).toHaveBeenCalledWith("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    expect(session.on).toHaveBeenCalledWith("Target.attachedToTarget", expect.any(Function));
  });

  it("registers the script on a newly attached child target before resuming it", async () => {
    const { session, handlers } = makeFakeSession();
    const { page, childSessions } = makePage(session);
    const childSend = vi.fn().mockResolvedValue(undefined);
    childSessions["child-session-1"] = { send: childSend };

    await installHcaptchaCallbackCaptureOnAllFrames(page);
    handlers["Target.attachedToTarget"]?.({ sessionId: "child-session-1" });

    await vi.waitFor(() => {
      expect(childSend).toHaveBeenCalledWith("Runtime.runIfWaitingForDebugger");
    });
    expect(page.getSessionById).toHaveBeenCalledWith("child-session-1");
    expect(childSend).toHaveBeenNthCalledWith(1, "Page.addScriptToEvaluateOnNewDocument", {
      source: buildHcaptchaCallbackCaptureScript(),
    });
    expect(childSend).toHaveBeenNthCalledWith(2, "Runtime.runIfWaitingForDebugger");
  });

  it("logs a warning and does not throw when Target.setAutoAttach rejects", async () => {
    loggerStub.warn.mockClear();
    const { session } = makeFakeSession();
    session.send.mockImplementation((method: string) =>
      method === "Target.setAutoAttach"
        ? Promise.reject(new Error("auto-attach unsupported"))
        : Promise.resolve(undefined)
    );
    const { page } = makePage(session);

    await expect(installHcaptchaCallbackCaptureOnAllFrames(page)).resolves.toBeUndefined();

    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringContaining("Target.setAutoAttach failed")
    );
  });

  it("logs a warning and still resolves when the main-session script registration rejects", async () => {
    loggerStub.warn.mockClear();
    const { session } = makeFakeSession();
    session.send.mockImplementation((method: string) =>
      method === "Page.addScriptToEvaluateOnNewDocument"
        ? Promise.reject(new Error("target closed"))
        : Promise.resolve(undefined)
    );
    const { page } = makePage(session);

    await expect(installHcaptchaCallbackCaptureOnAllFrames(page)).resolves.toBeUndefined();

    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringContaining("script registration failed")
    );
  });

  it("does nothing when a child target's session cannot be resolved", async () => {
    const { session, handlers } = makeFakeSession();
    const { page } = makePage(session);

    await installHcaptchaCallbackCaptureOnAllFrames(page);

    expect(() =>
      handlers["Target.attachedToTarget"]?.({ sessionId: "unknown-session" })
    ).not.toThrow();
  });

  it("never branches on siteId/plugin identity — the source is frame-agnostic", () => {
    const source = fs.readFileSync(path.join(__dirname, "captcha-callback-capture.ts"), "utf8");
    expect(source).not.toMatch(/siteId|pluginName|plugin\.meta/i);
  });
});
