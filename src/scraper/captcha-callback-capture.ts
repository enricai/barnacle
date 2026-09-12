import type { Page } from "@browserbasehq/stagehand";

import { getLogger } from "@/lib/logging";

/**
 * Site-agnostic capture of hCaptcha's programmatic render config. When a
 * site calls `hcaptcha.render(container, { sitekey, callback })` rather than
 * declaring `data-callback` on the widget element, the callback only ever
 * lives inside hCaptcha's own closure — nothing in the DOM names it. This
 * module builds a page-init script (for `Page.addInitScript`) that
 * monkeypatches `hcaptcha.render` before any site script runs, so every
 * render call's `{ sitekey, widgetId, callback }` lands in a page-global
 * registry a flow hook can query later, regardless of which plugin or site
 * triggered the render.
 */

const logger = getLogger({ name: "scraper/captcha-callback-capture" });

/** Page-global property name the capture script stores its registry under. */
export const HCAPTCHA_CALLBACK_REGISTRY_GLOBAL = "__barnacleHcaptchaCallbacks";

/**
 * Builds the self-contained init-script text. Safe to hand directly to
 * `Page.addInitScript` — it installs itself once, wraps `hcaptcha.render`
 * whether `window.hcaptcha` already exists or is assigned later by the
 * site's own hcaptcha.js, and never throws or changes render's real return
 * value or side effects.
 */
export function buildHcaptchaCallbackCaptureScript(): string {
  return `(function () {
    const REGISTRY_KEY = ${JSON.stringify(HCAPTCHA_CALLBACK_REGISTRY_GLOBAL)};
    const registry = window[REGISTRY_KEY] || (window[REGISTRY_KEY] = {});

    function recordRender(config, widgetId) {
      if (!config || typeof config !== "object") return;
      const callback = config.callback;
      if (typeof callback !== "function") return;
      const sitekey = config.sitekey;
      registry[sitekey + "::" + widgetId] = { sitekey, widgetId, callback };
    }

    function wrapRender(originalRender) {
      if (typeof originalRender !== "function" || originalRender.__barnacleWrapped) {
        return originalRender;
      }
      function wrapped() {
        const args = Array.prototype.slice.call(arguments);
        const config = args.length > 1 ? args[1] : args[0];
        const widgetId = originalRender.apply(this, args);
        try {
          recordRender(config, widgetId);
        } catch (err) {
          // capturing must never mask the real render outcome above
        }
        return widgetId;
      }
      wrapped.__barnacleWrapped = true;
      return wrapped;
    }

    function wrapHcaptchaObject(hcaptcha) {
      if (!hcaptcha || typeof hcaptcha !== "object") return hcaptcha;
      try {
        hcaptcha.render = wrapRender(hcaptcha.render);
      } catch (err) {
        // a non-writable render on some builds must not break the page
      }
      return hcaptcha;
    }

    const descriptor = Object.getOwnPropertyDescriptor(window, "hcaptcha");
    if (descriptor && descriptor.get && descriptor.get.__barnacleGetter) {
      wrapHcaptchaObject(descriptor.get());
      return;
    }

    const existing = window.hcaptcha;
    if (existing) {
      wrapHcaptchaObject(existing);
      return;
    }
    let stored;
    function get() {
      return stored;
    }
    get.__barnacleGetter = true;
    try {
      Object.defineProperty(window, "hcaptcha", {
        configurable: true,
        enumerable: true,
        get: get,
        set: function (value) {
          stored = wrapHcaptchaObject(value);
        },
      });
    } catch (err) {
      // property is already non-configurable on some builds; nothing to wrap
    }
  })();`;
}

/** `Target.attachedToTarget` event shape this module reads. */
interface TargetAttachedToTargetParams {
  sessionId: string;
}

/**
 * Registers the capture script via CDP so it is guaranteed to run before any
 * of a frame's own scripts, in every frame the page ever owns — deterministic
 * install rather than a race against that frame's own render() call.
 *
 * `Page.addScriptToEvaluateOnNewDocument` is a Page-domain (not frame-scoped)
 * command: per the CDP contract it installs before any script in ANY frame
 * of the target it's sent to — including same-origin child iframes that
 * share the main frame's target — and needs no execution context to already
 * exist, unlike `Runtime.evaluate`. That covers same-target frames.
 *
 * Cross-origin child frames get their own CDP target, so they need their own
 * registration: `Target.setAutoAttach({ autoAttach: true,
 * waitForDebuggerOnStart: true, flatten: true })` pauses each newly attached
 * target at the debugger statement before any of its scripts run; on
 * `Target.attachedToTarget` this re-sends `Page.addScriptToEvaluateOnNewDocument`
 * into that target's own session and only then resumes it via
 * `Runtime.runIfWaitingForDebugger` — so the script is installed before the
 * paused target is ever allowed to execute anything.
 *
 * Frame-agnostic: driven entirely by CDP target/frame lifecycle events,
 * regardless of which site or plugin owns any given frame.
 */
export async function installHcaptchaCallbackCaptureOnAllFrames(page: Page): Promise<void> {
  const session = page.getSessionForFrame(page.mainFrameId());
  const script = buildHcaptchaCallbackCaptureScript();

  const installInto = (target: {
    send<R = unknown>(method: string, params?: object): Promise<R>;
  }): Promise<void> =>
    target
      .send("Page.addScriptToEvaluateOnNewDocument", { source: script })
      .then(() => undefined)
      .catch((err: unknown) => {
        logger.warn(`hcaptcha callback capture: script registration failed: ${String(err)}`);
      });

  session.on<TargetAttachedToTargetParams>("Target.attachedToTarget", (params) => {
    const childSession = page.getSessionById(params.sessionId);
    if (!childSession) {
      logger.warn(
        `hcaptcha callback capture: no session found for attached target ${params.sessionId}`
      );
      return;
    }
    installInto(childSession)
      .then(() => childSession.send("Runtime.runIfWaitingForDebugger"))
      .catch((err: unknown) => {
        logger.warn(`hcaptcha callback capture: child target resume failed: ${String(err)}`);
      });
  });

  await Promise.all([
    installInto(session),
    session
      .send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      })
      .catch((err: unknown) => {
        logger.warn(`hcaptcha callback capture: Target.setAutoAttach failed: ${String(err)}`);
      }),
  ]);
}
