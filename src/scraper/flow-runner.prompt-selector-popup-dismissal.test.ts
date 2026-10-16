import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { dismissLeftoverPromptPopups } from "@/scraper/flow-runner";

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

describe("dismissLeftoverPromptPopups", () => {
  function fakes(counts: number[]): { sent: string[]; page: never; target: never } {
    const sent: string[] = [];
    const queue = [...counts];
    const page = {
      sendCDP: async (_m: string, p: { type: string; key: string }): Promise<void> => {
        if (p.type === "keyDown") sent.push(p.key);
      },
      waitForTimeout: async (): Promise<void> => undefined,
    };
    const target = { evaluate: async (): Promise<number> => queue.shift() ?? 0 };
    return { sent, page: page as never, target: target as never };
  }

  it("sends Escape while a popup (with options or emptied) stays visible", async () => {
    const f = fakes([1, 0]);
    await dismissLeftoverPromptPopups(f.page, f.target);
    expect(f.sent).toEqual(["Escape"]);
  });

  it("does nothing when no popup is visible", async () => {
    const f = fakes([0]);
    await dismissLeftoverPromptPopups(f.page, f.target);
    expect(f.sent).toEqual([]);
  });

  it("routes Escape through the child frame's CDP session when present", async () => {
    const f = fakes([1, 0]);
    const frameSent: string[] = [];
    const target = {
      evaluate: async (): Promise<number> => (frameSent.length ? 0 : 1),
      frame: {
        session: {
          send: async (_m: string, p: { type: string; key: string }): Promise<void> => {
            if (p.type === "keyDown") frameSent.push(p.key);
          },
        },
      },
    };
    await dismissLeftoverPromptPopups(f.page, target as never);
    expect(frameSent).toEqual(["Escape"]);
    expect(f.sent).toEqual([]);
  });
});
