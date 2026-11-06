import { describe, expect, it } from "vitest";
import { XPATH_TAIL_RETARGET_RESOLVE_FN_SRC } from "@/scraper/flow-runner";

// happy-dom has no XPath engine: document.evaluate is stubbed per (expr, ctx).
type N = {
  nodeType: number;
  id: string;
  shadowRoot?: N;
  children: N[];
  tagName?: string;
  textContent?: string;
  getAttribute: (n: string) => string | null;
  querySelectorAll: () => N[];
  matches: () => boolean;
};
const mk = (id: string, nodeType = 1, children: N[] = [], textContent = ""): N => ({
  id,
  nodeType,
  children,
  textContent,
  tagName: "BUTTON",
  getAttribute: () => null,
  querySelectorAll: () => children,
  matches: () => false,
});

describe("tail-retarget resolver uses the shadow-aware snapshot resolver", () => {
  it("finds a tail match that only exists inside an open shadow root", () => {
    const btn = mk("go", 1, [], "Continue");
    const section = mk("section", 1, [btn]);
    const root = mk("root", 11, [section]);
    const host = mk("host");
    host.shadowRoot = root;
    const doc = mk("doc", 9, [host]);
    const table = new Map<string, N[]>([
      ["//my-app@doc", [host]],
      [".//button@section", [btn]],
    ]);
    const evaluate = (expr: string, ctx: N) => {
      const hits = table.get(`${expr}@${ctx.id}`) ?? [];
      return { singleNodeValue: hits[0] ?? null, snapshotLength: hits.length, snapshotItem: (i: number) => hits[i] };
    };
    const fn = new Function("document", "XPathResult", `return ${XPATH_TAIL_RETARGET_RESOLVE_FN_SRC};`)(
      { ...doc, evaluate },
      { FIRST_ORDERED_NODE_TYPE: 9, ORDERED_NODE_SNAPSHOT_TYPE: 7 }
    ) as (t: string, p: boolean, ph: string[]) => N | null;
    // Native "//my-app//button" finds nothing; the shadow walk must.
    expect(fn("my-app//button", false, [])?.id).toBe("go");
    expect(fn("my-app//button", false, ["continue"])?.id).toBe("go");
    expect(fn("my-app//button", false, ["unrelated"])).toBeNull();
  });
});
