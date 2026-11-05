import { describe, expect, it } from "vitest";
import { buildCentreAndHitTestFn } from "./trusted-click.js";

interface FakeNode {
  nodeType: number;
  parentNode: FakeNode | null;
  host?: unknown;
  tagName?: string;
  id?: string;
}

function run(hit: FakeNode, el: FakeNode): { state: string } {
  const target = {
    ...el,
    isConnected: true,
    scrollIntoView: () => {},
    getBoundingClientRect: () => ({ left: 0, right: 10, top: 0, bottom: 10 }),
    getRootNode: () => ({ elementFromPoint: () => hit }),
  };
  const fn = new Function("getComputedStyle", `return (${buildCentreAndHitTestFn()})`)(() => ({}));
  // Keep identity: hit-test compares against `this`.
  return fn.call(Object.assign(el, target));
}

describe("hit-test host hop", () => {
  it("does not walk onto an anchor's string .host", () => {
    const a: FakeNode = { nodeType: 1, parentNode: null, host: "example.com", tagName: "A" };
    const child: FakeNode = { nodeType: 1, parentNode: a, tagName: "SPAN" };
    const outer: FakeNode = { nodeType: 1, parentNode: null, tagName: "DIV" };
    a.parentNode = outer;
    expect(run(child, outer).state).toBe("hit");
    expect(run(child, a).state).toBe("hit");
  });

  it("hops from a real shadow root to its host", () => {
    const host: FakeNode = { nodeType: 1, parentNode: null, tagName: "X-H" };
    const root: FakeNode = { nodeType: 11, parentNode: null, host };
    const inner: FakeNode = { nodeType: 1, parentNode: root, tagName: "B" };
    expect(run(inner, host).state).toBe("hit");
  });
});
