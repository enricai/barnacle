import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import type { FrameTarget } from "@/scraper/frame-target";
import { installSameTabNavigation, SAME_TAB_NAVIGATION_EXPR } from "@/scraper/same-tab-navigation";

function makeWindow(html: string): Window {
  const win = new Window({ url: "https://example.com/a" });
  win.document.body.innerHTML = html;
  win.eval(SAME_TAB_NAVIGATION_EXPR);
  return win;
}

describe("same-tab-navigation", () => {
  it("retargets a click on an element nested inside a target=_blank anchor", () => {
    const win = makeWindow('<a id="x" target="_blank" href="/b"><span id="in">Apply</span></a>');
    win.document
      .getElementById("in")
      ?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, composed: true }));
    expect(win.document.getElementById("x")?.getAttribute("target")).toBe("_self");
  });

  it("retargets a named non-keyword target but leaves _top alone", () => {
    const win = makeWindow(
      '<a id="n" target="applyWindow" href="/b">n</a><a id="t" target="_top" href="/c">t</a>'
    );
    for (const id of ["n", "t"]) {
      win.document
        .getElementById(id)
        ?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, composed: true }));
    }
    expect(win.document.getElementById("n")?.getAttribute("target")).toBe("_self");
    expect(win.document.getElementById("t")?.getAttribute("target")).toBe("_top");
  });

  it("retargets an anchor that inherits a new-tab target from <base>", () => {
    const win = makeWindow('<base target="_blank"><a id="x" href="/b">x</a>');
    win.document
      .getElementById("x")
      ?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, composed: true }));
    expect(win.document.getElementById("x")?.getAttribute("target")).toBe("_self");
  });

  it("is idempotent per document", () => {
    const win = makeWindow("<p></p>");
    const open = win.open;
    win.eval(SAME_TAB_NAVIGATION_EXPR);
    expect(win.open).toBe(open);
  });

  it("swallows an evaluate failure so a wedged frame cannot fail the step", async () => {
    const evaluate = vi.fn().mockRejectedValue(new Error("detached"));
    await expect(
      installSameTabNavigation({ evaluate } as unknown as FrameTarget)
    ).resolves.toBeUndefined();
    expect(evaluate).toHaveBeenCalledWith(SAME_TAB_NAVIGATION_EXPR);
  });
});
