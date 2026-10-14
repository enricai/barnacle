import type { FrameTarget } from "@/scraper/frame-target";

/**
 * Page-side installer that makes new-browsing-context navigations (anchors and
 * forms with a non-self `target`, `window.open(url)`) land in the current tab.
 * Idempotent per document; a navigation discards it, so callers re-install
 * before each click attempt.
 */
export const SAME_TAB_NAVIGATION_EXPR = `(() => {
  try {
    if (window.__barnacleSameTab) return;
    window.__barnacleSameTab = true;
    const KEEP = ["_self", "_parent", "_top"];
    const baseTarget = () => {
      const base = document.querySelector("base[target]");
      return base ? base.getAttribute("target") : null;
    };
    const opensElsewhere = (value) => !!value && !KEEP.includes(value.toLowerCase());
    const retarget = (el, attr) => {
      const own = el.getAttribute(attr);
      if (opensElsewhere(own) || (own === null && opensElsewhere(baseTarget()))) {
        el.setAttribute(attr, "_self");
      }
    };
    window.addEventListener("click", (event) => {
      const path = event.composedPath ? event.composedPath() : [];
      for (const node of path) {
        if (node && node.nodeType === 1 && (node.tagName === "A" || node.tagName === "AREA")) {
          retarget(node, "target");
          return;
        }
      }
    }, true);
    window.addEventListener("submit", (event) => {
      const form = event.target;
      if (form && form.nodeType === 1 && form.tagName === "FORM") retarget(form, "target");
      const submitter = event.submitter;
      if (submitter && submitter.hasAttribute && submitter.hasAttribute("formtarget")) {
        retarget(submitter, "formtarget");
      }
    }, true);
    const nativeOpen = window.open;
    window.open = function (url, target) {
      const hasUrl = url !== undefined && url !== null && String(url) !== "" && String(url) !== "about:blank";
      if (!hasUrl || (target && KEEP.includes(String(target).toLowerCase()))) {
        return nativeOpen.apply(window, arguments);
      }
      window.location.assign(new URL(String(url), document.baseURI).href);
      return window;
    };
  } catch (e) {}
})()`;

/**
 * Keeps a click that would open a new tab inside the driven page, so the run
 * never has to chase a second tab whose state the original page cannot see.
 * Best-effort: a wedged or navigating frame must not fail the step.
 */
export async function installSameTabNavigation(target: FrameTarget): Promise<void> {
  await target.evaluate(SAME_TAB_NAVIGATION_EXPR).catch(() => undefined);
}
