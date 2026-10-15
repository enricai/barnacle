import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import type { FrameTarget } from "@/scraper/frame-target";
import { isClickPointUnobscured } from "@/scraper/trusted-click";

function targetFor(hitId: string): FrameTarget {
  const window = new Window({ url: "https://example.com/" });
  window.document.body.innerHTML = `<div id="field"><span id="inner"></span></div><div id="overlay"></div>`;
  const doc = window.document as unknown as {
    elementFromPoint: (x: number, y: number) => unknown;
    getElementById: (id: string) => unknown;
  };
  doc.elementFromPoint = () => doc.getElementById(hitId);
  const evaluate = async (expr: string): Promise<unknown> =>
    new window.Function("document", "getComputedStyle", `return (${expr});`)(
      window.document,
      window.getComputedStyle.bind(window)
    );
  return {
    evaluate,
    locator: () => ({ click: async () => undefined }),
  } as unknown as FrameTarget;
}

describe("isClickPointUnobscured", () => {
  it("is true when the centre resolves to the element or a descendant", async () => {
    expect(await isClickPointUnobscured(targetFor("field"), "#field")).toBe(true);
    expect(await isClickPointUnobscured(targetFor("inner"), "#field")).toBe(true);
  });

  it("is false when a sibling overlay covers the centre", async () => {
    expect(await isClickPointUnobscured(targetFor("overlay"), "#field")).toBe(false);
  });
});
