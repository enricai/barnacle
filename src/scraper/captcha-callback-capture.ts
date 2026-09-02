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
    if (window[REGISTRY_KEY]) return;
    const registry = {};
    window[REGISTRY_KEY] = registry;

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

    const existing = window.hcaptcha;
    if (existing) {
      wrapHcaptchaObject(existing);
      return;
    }
    let stored;
    try {
      Object.defineProperty(window, "hcaptcha", {
        configurable: true,
        enumerable: true,
        get: function () {
          return stored;
        },
        set: function (value) {
          stored = wrapHcaptchaObject(value);
        },
      });
    } catch (err) {
      // property is already non-configurable on some builds; nothing to wrap
    }
  })();`;
}
